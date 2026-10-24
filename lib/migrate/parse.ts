import { createHash } from "node:crypto";

// Reading a school_app migration file for registration, and preparing its SQL
// to run. Pure: no database, no filesystem.

export const MIGRATION_FILE = /^(\d{14})_([a-z0-9_]+)\.sql$/;
const TAG = /^[0-9a-f]{40}$/;

export class MigrationFileError extends Error {}

export type ParsedMigration = {
  version: string;
  name: string; // file name without .sql
  checksum: string; // sha256 of the normalised SQL
  kind: "expand" | "contract";
  minAppVersion: string | null;
  sql: string; // normalised: no BOM, LF line endings
};

/** One checksum on every machine: no BOM, and LF endings whatever git did. */
export function normalizeSql(raw: string): string {
  return raw.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}

export const checksumOf = (sql: string) => createHash("sha256").update(sql, "utf8").digest("hex");

/** Blanks out comments, quoted strings and dollar-quoted bodies, keeping length. */
export function maskLiterals(sql: string): string {
  let out = "";
  let i = 0;
  const blank = (s: string) => s.replace(/[^\n]/g, " ");
  while (i < sql.length) {
    const rest = sql.slice(i);
    let m: RegExpMatchArray | null;
    if ((m = rest.match(/^--[^\n]*/))) {
      out += blank(m[0]);
      i += m[0].length;
    } else if (rest.startsWith("/*")) {
      let depth = 0;
      let j = i;
      while (j < sql.length) {
        if (sql.startsWith("/*", j)) {
          depth++;
          j += 2;
        } else if (sql.startsWith("*/", j)) {
          depth--;
          j += 2;
          if (depth === 0) break;
        } else j++;
      }
      out += blank(sql.slice(i, j));
      i = j;
    } else if ((m = rest.match(/^\$([A-Za-z_][A-Za-z0-9_]*)?\$/))) {
      const tag = m[0];
      const end = sql.indexOf(tag, i + tag.length);
      const j = end === -1 ? sql.length : end + tag.length;
      out += blank(sql.slice(i, j));
      i = j;
    } else if (rest[0] === "'") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'" && sql[j + 1] === "'") j += 2;
        else if (sql[j] === "'") {
          j++;
          break;
        } else j++;
      }
      out += blank(sql.slice(i, j));
      i = j;
    } else {
      out += sql[i];
      i++;
    }
  }
  return out;
}

/**
 * Files that wrap themselves in BEGIN; ... COMMIT; would clash with the
 * runner's own transaction, so a matching pair is removed before running.
 * Throws if only one end is present.
 */
export function stripTransactionWrapper(sql: string): string {
  const masked = maskLiterals(sql);
  const begin = masked.match(/^\s*(begin|start\s+transaction)\s*;/i);
  const commit = masked.match(/;?\s*commit\s*;\s*$/i);
  if (!begin && !commit) return sql;
  if (!begin || !commit) {
    throw new MigrationFileError(
      "It has a BEGIN without a matching COMMIT at the end (or the reverse)."
    );
  }
  const head = begin[0].length;
  const tailStart = masked.length - commit[0].length;
  // keep the semicolon that ended the last real statement
  const keepSemicolon = commit[0].trim().startsWith(";") ? ";" : "";
  return sql.slice(head, tailStart) + keepSemicolon;
}

/** Statement keywords that cannot run inside a transaction. */
const UNTRANSACTABLE =
  /\b(create\s+(unique\s+)?index\s+concurrently|drop\s+index\s+concurrently|reindex\s+.*concurrently|vacuum|create\s+database|drop\s+database|create\s+tablespace|alter\s+system)\b/i;

/** Transaction control left over after the wrapper is removed. */
function hasTransactionControl(masked: string): boolean {
  return masked
    .split(";")
    .some((stmt) =>
      /^\s*(begin|commit|rollback|savepoint|release\s+savepoint|start\s+transaction|end)\b/i.test(
        stmt
      )
    );
}

/**
 * Things the old app may not survive. A migration containing one must say
 * `kind=contract`, with the app version that stops needing it. This is a net
 * for the usual accidents, not a proof: it cannot understand your schema.
 */
const CONTRACT_RISKS: [RegExp, string][] = [
  [/\bdrop\s+table\b(?!\s+if\s+exists\s+(pg_temp|tmp_))/i, "drops a table"],
  [/\bdrop\s+column\b/i, "drops a column"],
  [/\bdrop\s+(type|schema|view|materialized\s+view)\b/i, "drops a type, schema or view"],
  [/\balter\s+column\b[^;]*\btype\b/i, "changes a column type"],
  [/\balter\s+column\b[^;]*\bset\s+not\s+null\b/i, "makes a column NOT NULL"],
  [/\brename\s+(to|column)\b/i, "renames something"],
  [/\bdrop\s+constraint\b/i, "drops a constraint"],
  [/\btruncate\b/i, "truncates a table"],
];

export function findContractRisks(sql: string): string[] {
  const masked = maskLiterals(sql);
  return CONTRACT_RISKS.filter(([re]) => re.test(masked)).map(([, why]) => why);
}

const HEADER = /^--\s*control-plane:\s*(.+)$/i;

function parseHeader(sql: string, file: string) {
  const lines = sql.split("\n").slice(0, 15);
  const line = lines.map((l) => l.trim().match(HEADER)).find(Boolean);
  if (!line) return null;
  const fields: Record<string, string> = {};
  for (const part of line[1].trim().split(/\s+/)) {
    const [k, v] = part.split("=");
    if (!k || v === undefined || !["kind", "min_app_version"].includes(k)) {
      throw new MigrationFileError(`${file}: unrecognised header field "${part}".`);
    }
    fields[k] = v;
  }
  if (fields.kind !== undefined && !["expand", "contract"].includes(fields.kind)) {
    throw new MigrationFileError(`${file}: kind must be expand or contract.`);
  }
  if (fields.min_app_version !== undefined && !TAG.test(fields.min_app_version)) {
    throw new MigrationFileError(
      `${file}: min_app_version must be a full 40-character commit hash.`
    );
  }
  return fields;
}

/**
 * Validates one migration file for registration.
 * `baseline: true` is for migrations every school already has: they are
 * registered as expand and not checked for contract risks.
 */
export function parseMigration(
  fileName: string,
  content: string,
  opts: { baseline?: boolean } = {}
): ParsedMigration {
  const m = fileName.match(MIGRATION_FILE);
  if (!m) {
    throw new MigrationFileError(
      `${fileName}: the name must be <14-digit timestamp>_<lowercase_words>.sql.`
    );
  }
  const sql = normalizeSql(content);
  if (sql.trim() === "") throw new MigrationFileError(`${fileName}: the file is empty.`);

  const header = parseHeader(sql, fileName);
  const kind = (header?.kind as "expand" | "contract" | undefined) ?? "expand";
  const minAppVersion = header?.min_app_version ?? null;
  if (kind === "contract" && !minAppVersion) {
    throw new MigrationFileError(
      `${fileName}: a contract migration needs min_app_version=<commit>.`
    );
  }
  if (kind === "expand" && minAppVersion) {
    throw new MigrationFileError(
      `${fileName}: min_app_version only applies to a contract migration.`
    );
  }

  let body: string;
  try {
    body = stripTransactionWrapper(sql);
  } catch (e) {
    throw new MigrationFileError(`${fileName}: ${(e as Error).message}`);
  }
  const masked = maskLiterals(body);
  if (UNTRANSACTABLE.test(masked)) {
    throw new MigrationFileError(
      `${fileName}: it uses a statement that cannot run inside a transaction (such as CREATE INDEX CONCURRENTLY).`
    );
  }
  if (hasTransactionControl(masked)) {
    throw new MigrationFileError(
      `${fileName}: it manages its own transaction in the middle of the file.`
    );
  }
  if (!opts.baseline && kind === "expand") {
    const risks = findContractRisks(body);
    if (risks.length > 0) {
      throw new MigrationFileError(
        `${fileName}: it ${risks.join(", ")}. The old app may not survive that. If it is safe in two steps, declare "-- control-plane: kind=contract min_app_version=<commit>" with the first app version that no longer needs it, and ship it in a later release.`
      );
    }
  }

  return {
    version: m[1],
    name: `${m[1]}_${m[2]}`,
    checksum: checksumOf(sql),
    kind,
    minAppVersion,
    sql,
  };
}
