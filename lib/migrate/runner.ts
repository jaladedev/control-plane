import { checksumOf, stripTransactionWrapper } from "@/lib/migrate/parse";

// Applies a school's pending migrations to its own database, one transaction
// per migration, stopping at the first failure. It only needs something that
// can run a query, so tests use throwaway Postgres databases.
//
// Source of truth for "what does this school have" is the school's own
// supabase_migrations.schema_migrations table (the Supabase CLI's), read at
// the start of every run. The control plane's migration_runs is the history;
// it is never trusted over the school.

export type PgLike = {
  query: (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
};

export type RunnerMigration = {
  id: string;
  version: string;
  name: string;
  sql: string;
  checksum: string;
  kind: "expand" | "contract";
  minAppVersion: string | null;
  releaseSeq: number;
};

export type RunRecorder = {
  start: (m: RunnerMigration) => Promise<string>;
  finish: (runId: string, ok: boolean, error?: string) => Promise<void>;
};

export type RunnerInput = {
  db: PgLike;
  registered: RunnerMigration[];
  /** Apply migrations registered with this release or an earlier one. */
  targetSeq: number;
  /** The image tag the school runs now (null if unknown). */
  currentTag: string | null;
  /** Order of a release tag, or null when the tag is not a registered release. */
  appSeq: (tag: string | null) => number | null;
  recorder: RunRecorder;
  log?: (message: string) => void;
};

export type RunnerResult = {
  applied: string[];
  alreadyApplied: number;
  latestVersion: string | null;
};

export class MigrationError extends Error {
  /**
   * The newest migration the school has after this run, even though it failed:
   * earlier migrations in the same run stay applied. Set by
   * applyPendingMigrations so callers can record the school's real state.
   */
  latestVersion: string | null = null;

  constructor(
    message: string,
    public readonly applied: string[],
    public readonly failedMigration?: string
  ) {
    super(message);
  }
}

// One lock per school database, so two runners (or a person with the Supabase
// CLI) cannot migrate it at the same time. Released with the connection.
const LOCK_KEY = 7234001;
const LOCK_TIMEOUT = "30s";
const STATEMENT_TIMEOUT = "15min";

export async function readAppliedVersions(db: PgLike): Promise<string[]> {
  await db.query("create schema if not exists supabase_migrations");
  await db.query(
    `create table if not exists supabase_migrations.schema_migrations (
       version text not null primary key, statements text[], name text)`
  );
  const { rows } = await db.query("select version from supabase_migrations.schema_migrations");
  return rows.map((r) => String(r.version));
}

/** Like readAppliedVersions but creates nothing: for looking, not migrating. */
export async function readAppliedVersionsReadOnly(db: PgLike): Promise<string[]> {
  const has = await db.query("select to_regclass('supabase_migrations.schema_migrations') as t");
  if (!has.rows[0]?.t) return [];
  const { rows } = await db.query("select version from supabase_migrations.schema_migrations");
  return rows.map((r) => String(r.version));
}

/** Everything that can be refused is refused here, before anything is applied. */
export function planMigrations(
  input: Pick<RunnerInput, "registered" | "targetSeq" | "currentTag" | "appSeq">,
  applied: string[]
): { pending: RunnerMigration[]; alreadyApplied: number } {
  const known = new Set(input.registered.map((m) => m.version));
  const unknown = applied.filter((v) => !known.has(v)).sort();
  if (unknown.length > 0) {
    throw new MigrationError(
      `The school has migrations the control plane does not know: ${unknown.slice(0, 5).join(", ")}${unknown.length > 5 ? "…" : ""}. Register them first, or find out who applied them.`,
      []
    );
  }

  const appliedSet = new Set(applied);
  const pending = input.registered
    .filter((m) => m.releaseSeq <= input.targetSeq && !appliedSet.has(m.version))
    .sort((a, b) => a.version.localeCompare(b.version));

  const newest = applied.length ? [...applied].sort().at(-1)! : null;
  const outOfOrder = pending.find((m) => newest !== null && m.version < newest);
  if (outOfOrder) {
    throw new MigrationError(
      `${outOfOrder.name} is older than the newest migration the school has (${newest}); refusing to apply it out of order.`,
      [],
      outOfOrder.name
    );
  }

  const currentSeq = input.appSeq(input.currentTag);
  for (const m of pending) {
    if (checksumOf(m.sql) !== m.checksum) {
      throw new MigrationError(
        `${m.name}: the stored SQL does not match its checksum. The registry is damaged; do not run it.`,
        [],
        m.name
      );
    }
    if (m.kind === "contract") {
      const needed = input.appSeq(m.minAppVersion);
      if (needed === null || currentSeq === null || currentSeq < needed) {
        throw new MigrationError(
          `${m.name} is a contract migration that needs app version ${m.minAppVersion?.slice(0, 12) ?? "?"} or newer, but this school runs ${input.currentTag?.slice(0, 12) ?? "an unknown version"}. Deploy the newer app first.`,
          [],
          m.name
        );
      }
    }
  }
  return { pending, alreadyApplied: applied.length };
}

export async function applyPendingMigrations(input: RunnerInput): Promise<RunnerResult> {
  const { db, recorder } = input;
  const log = input.log ?? (() => {});

  const lock = await db.query("select pg_try_advisory_lock($1) as ok", [LOCK_KEY]);
  if (lock.rows[0]?.ok !== true) {
    throw new MigrationError("Another migration run holds this school's database lock.", []);
  }
  let applied: string[] = [];
  const doneVersions: string[] = [];
  try {
    applied = await readAppliedVersions(db);
    const { pending, alreadyApplied } = planMigrations(input, applied);
    const done: string[] = [];

    for (const m of pending) {
      log(`applying ${m.name}`);
      const runId = await recorder.start(m); // no record, no migration
      try {
        await db.query("begin");
        await db.query(`set local lock_timeout = '${LOCK_TIMEOUT}'`);
        await db.query(`set local statement_timeout = '${STATEMENT_TIMEOUT}'`);
        await db.query(stripTransactionWrapper(m.sql));
        await db.query(
          "insert into supabase_migrations.schema_migrations (version, name, statements) values ($1, $2, $3)",
          [m.version, m.name.slice(15), [m.sql]]
        );
        await db.query("commit");
      } catch (error) {
        await db.query("rollback").catch(() => {});
        const message = error instanceof Error ? error.message : String(error);
        await recorder.finish(runId, false, message).catch(() => {});
        throw new MigrationError(`${m.name} failed: ${message}`, done, m.name);
      }
      done.push(m.name);
      doneVersions.push(m.version);
      // The migration is committed. A failure to record it must not hide that:
      // the next run reads the school's own table and reconciles the history.
      await recorder.finish(runId, true).catch((e) => log(`could not record ${m.name}: ${e}`));
    }

    const latest = [...applied, ...pending.map((m) => m.version)].sort().at(-1) ?? null;
    return { applied: done, alreadyApplied, latestVersion: latest };
  } catch (error) {
    if (error instanceof MigrationError) {
      error.latestVersion = [...applied, ...doneVersions].sort().at(-1) ?? null;
    }
    throw error;
  } finally {
    await db.query("select pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => {});
  }
}
