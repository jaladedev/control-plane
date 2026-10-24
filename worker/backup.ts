import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A backup of a school's database, taken by the worker before it migrates.
// The decision (is one needed?) is a pure function, tested on its own; the
// provider does the slow I/O with the same tools scripts/backup.sh uses:
// pg_dump, age and the aws CLI (pointed at R2).
//
// Handling rules, in the order they matter:
//  - The school's database URL goes to pg_dump through environment variables,
//    never the command line, where `ps` would show it.
//  - Child processes get a minimal environment. They never see the worker's
//    other secrets (the other schools' URLs, the control-plane service key).
//  - The plaintext dump exists only inside a private temp directory and is
//    deleted as soon as it has been encrypted. Only the public age key is here.
//  - A backup counts only after the encrypted object has been uploaded and R2
//    reports the size we sent.

export type BackupPolicy = "required" | "skip_if_expand_only";

export type PendingMigration = { name: string; kind: "expand" | "contract" };

export type BackupDecision = { take: boolean; reason: string };

/**
 * Whether to back up before applying these pending migrations. Fails closed:
 * anything but an explicit, recognised "skip" policy means a backup.
 */
export function decideBackup(policy: string, pending: PendingMigration[]): BackupDecision {
  if (pending.length === 0) return { take: false, reason: "no migrations are pending" };
  if (policy === "skip_if_expand_only") {
    const contract = pending.filter((m) => m.kind !== "expand");
    if (contract.length > 0) {
      return {
        take: true,
        reason: `a contract migration is pending (${contract[0].name}), so a backup is always taken`,
      };
    }
    return {
      take: false,
      reason: "only expand migrations are pending and the rollout allows skipping the backup",
    };
  }
  return { take: true, reason: "the rollout requires a backup" };
}

export type BackupRequest = {
  slug: string;
  /** The id of the backups row, used to make the object name unique. */
  backupId: string;
  databaseUrl: string;
};

export type BackupArtifact = { objectKey: string; sizeBytes: number; sha256: string };

export interface BackupProvider {
  /** Dumps, encrypts and uploads. Resolves only when the object is safely stored. */
  create(req: BackupRequest): Promise<BackupArtifact>;
  /** Deletes a backup object this provider made. Refuses any other key. */
  remove(objectKey: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Running tools
// ---------------------------------------------------------------------------

export type RunResult = { code: number | null; stdout: string; stderr: string; timedOut: boolean };
export type Run = (
  cmd: string,
  args: string[],
  opts: { env: Record<string, string>; timeoutMs: number }
) => Promise<RunResult>;

export const spawnRun: Run = (cmd, args, { env, timeoutMs }) =>
  new Promise((resolve) => {
    // `env` is the whole environment of the child: nothing else is inherited.
    const child = spawn(cmd, args, {
      env: env as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout = (stdout + d).slice(-20_000)));
    child.stderr.on("data", (d) => (stderr = (stderr + d).slice(-20_000)));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: `${stderr}${e.message}`, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });

export type ToolsBackupConfig = {
  /** The age PUBLIC key (age1...). The private key is never on this machine. */
  ageRecipient: string;
  r2: { endpoint: string; bucket: string; accessKeyId: string; secretAccessKey: string };
  /** Key prefix in the bucket; objects are <prefix>/<slug>/<stamp>-<id>.dump.age. */
  prefix: string;
  /** Path of the CA certificate for verifying school databases (optional). */
  caFile?: string;
  /** Where the temporary dump is written. Default: the system temp directory. */
  tmpDir?: string;
  timeoutMs: number;
  run?: Run;
  now?: () => Date;
  bins?: Partial<Record<"pgDump" | "pgRestore" | "age" | "aws", string>>;
};

const SLUG = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PREFIX = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const OBJECT_KEY = /^[A-Za-z0-9][A-Za-z0-9._/-]*\.dump\.age$/;
const MIN_ENCRYPTED_BYTES = 1024;
const CLIP = 600;

// What pg_dump is asked to dump: the app's data, its users, and the migration
// history the runner depends on. Storage objects (uploaded files) are not in
// the database and are not part of this backup.
const SCHEMAS = ["public", "auth", "supabase_migrations"];

const clip = (s: string, n = CLIP) => {
  const t = s.trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

async function sha256Of(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** libpq reads these, so the URL never appears in a process listing. */
export function libpqEnv(databaseUrl: string, caFile?: string): Record<string, string> {
  const u = new URL(databaseUrl);
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const local = ["localhost", "127.0.0.1", "::1"].includes(host);
  const env: Record<string, string> = {
    PGHOST: host,
    PGPORT: u.port || "5432",
    PGUSER: decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password),
    PGDATABASE: decodeURIComponent(u.pathname.replace(/^\//, "")) || "postgres",
    PGCONNECT_TIMEOUT: "15",
  };
  if (local) env.PGSSLMODE = "disable";
  else if (caFile) Object.assign(env, { PGSSLMODE: "verify-full", PGSSLROOTCERT: caFile });
  else env.PGSSLMODE = "require";
  return env;
}

export class ToolsBackupProvider implements BackupProvider {
  private readonly run: Run;
  private readonly now: () => Date;
  private readonly bin: Record<"pgDump" | "pgRestore" | "age" | "aws", string>;

  constructor(private readonly cfg: ToolsBackupConfig) {
    if (!/^age1[0-9a-z]{20,}$/.test(cfg.ageRecipient)) {
      throw new Error("BACKUP_AGE_RECIPIENT must be an age public key (age1...).");
    }
    if (!PREFIX.test(cfg.prefix) || cfg.prefix.includes("..") || cfg.prefix.endsWith("/")) {
      throw new Error("BACKUP_PREFIX has characters it should not.");
    }
    this.run = cfg.run ?? spawnRun;
    this.now = cfg.now ?? (() => new Date());
    this.bin = {
      pgDump: "pg_dump",
      pgRestore: "pg_restore",
      age: "age",
      aws: "aws",
      ...cfg.bins,
    };
  }

  /** The child's whole environment: a PATH and what the one tool needs. */
  private childEnv(extra: Record<string, string>): Record<string, string> {
    const base: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin" };
    if (process.env.HOME) base.HOME = process.env.HOME;
    return { ...base, ...extra };
  }

  private awsEnv(): Record<string, string> {
    const { accessKeyId, secretAccessKey } = this.cfg.r2;
    return this.childEnv({
      AWS_ACCESS_KEY_ID: accessKeyId,
      AWS_SECRET_ACCESS_KEY: secretAccessKey,
      AWS_DEFAULT_REGION: "auto",
      AWS_EC2_METADATA_DISABLED: "true",
    });
  }

  /** Removes anything secret from tool output before it is put in an error. */
  private scrub(text: string, extra: string[] = []): string {
    let out = text.replace(/postgres(?:ql)?:\/\/[^\s'"]+/gi, "[database url]");
    const secrets = [this.cfg.r2.secretAccessKey, this.cfg.r2.accessKeyId, ...extra];
    for (const s of secrets) if (s.length >= 6) out = out.split(s).join("[secret]");
    return out;
  }

  private async tool(
    name: string,
    cmd: string,
    args: string[],
    env: Record<string, string>,
    timeoutMs: number,
    scrubbed: string[]
  ): Promise<RunResult> {
    const res = await this.run(cmd, args, { env, timeoutMs });
    if (res.timedOut) {
      throw new Error(`${name} timed out after ${Math.round(timeoutMs / 60_000)} minutes.`);
    }
    if (res.code !== 0) {
      const detail = clip(this.scrub(res.stderr || res.stdout, scrubbed));
      throw new Error(`${name} failed (exit ${res.code ?? "none"})${detail ? `: ${detail}` : "."}`);
    }
    return res;
  }

  async create(req: BackupRequest): Promise<BackupArtifact> {
    if (!SLUG.test(req.slug))
      throw new Error("The school's slug looks wrong; refusing to back it up.");
    if (!UUID.test(req.backupId)) throw new Error("The backup id looks wrong.");
    const { cfg } = this;
    const stamp = this.now()
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d+Z$/, "Z");
    const objectKey = `${cfg.prefix}/${req.slug}/${stamp}-${req.backupId.slice(0, 8)}.dump.age`;

    const url = new URL(req.databaseUrl);
    const password = decodeURIComponent(url.password);
    const scrubbed = password ? [password] : [];
    const dbEnv = this.childEnv(libpqEnv(req.databaseUrl, cfg.caFile));
    const small = Math.min(cfg.timeoutMs, 15 * 60_000);

    // mkdtemp makes the directory readable by this user only.
    const dir = await mkdtemp(join(cfg.tmpDir ?? tmpdir(), "cp-backup-"));
    const dump = join(dir, "school.dump");
    const enc = join(dir, "school.dump.age");
    try {
      await this.tool(
        "pg_dump",
        this.bin.pgDump,
        [
          "--format=custom",
          "--no-owner",
          "--no-privileges",
          "--lock-wait-timeout=30000",
          ...SCHEMAS.map((s) => `--schema=${s}`),
          `--file=${dump}`,
        ],
        dbEnv,
        cfg.timeoutMs,
        scrubbed
      );

      // A dump that cannot be listed is a failed backup even though pg_dump
      // exited 0.
      if ((await stat(dump)).size === 0) throw new Error("pg_dump wrote an empty file.");
      const listing = await this.tool(
        "pg_restore --list",
        this.bin.pgRestore,
        ["--list", dump],
        this.childEnv({}),
        small,
        scrubbed
      );
      if (!/^\d+; \d+ \d+ (SCHEMA|TABLE) /m.test(listing.stdout)) {
        throw new Error("The dump has no schema or table entries; it is not a usable backup.");
      }

      await this.tool(
        "age",
        this.bin.age,
        ["-r", cfg.ageRecipient, "-o", enc, dump],
        this.childEnv({}),
        small,
        scrubbed
      );
      // The unencrypted copy goes now, not when the directory does.
      await rm(dump, { force: true });

      const sizeBytes = (await stat(enc)).size;
      if (sizeBytes <= MIN_ENCRYPTED_BYTES) {
        throw new Error(`The encrypted backup is suspiciously small (${sizeBytes} bytes).`);
      }
      const sha256 = await sha256Of(enc);

      const base = ["--endpoint-url", cfg.r2.endpoint];
      await this.tool(
        "upload to R2",
        this.bin.aws,
        ["s3", "cp", "--only-show-errors", ...base, enc, `s3://${cfg.r2.bucket}/${objectKey}`],
        this.awsEnv(),
        small,
        scrubbed
      );

      // Trust R2's word, not ours: the stored object must be the size we sent.
      const head = await this.tool(
        "check of the uploaded backup",
        this.bin.aws,
        [
          "s3api",
          "head-object",
          ...base,
          "--bucket",
          cfg.r2.bucket,
          "--key",
          objectKey,
          "--query",
          "ContentLength",
          "--output",
          "text",
        ],
        this.awsEnv(),
        small,
        scrubbed
      );
      if (head.stdout.trim() !== String(sizeBytes)) {
        await this.remove(objectKey).catch(() => {});
        throw new Error(
          `R2 reports ${head.stdout.trim() || "no size"} bytes for the backup, not ${sizeBytes}.`
        );
      }
      return { objectKey, sizeBytes, sha256 };
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async remove(objectKey: string): Promise<void> {
    const { cfg } = this;
    // Only objects this provider could have made: under its prefix, ending in
    // .dump.age, no path tricks. A bad key in the database cannot delete
    // anything else in the bucket.
    if (
      !objectKey.startsWith(`${cfg.prefix}/`) ||
      !OBJECT_KEY.test(objectKey) ||
      objectKey.includes("..") ||
      objectKey.includes("//")
    ) {
      throw new Error("Refusing to delete an object that is not one of this worker's backups.");
    }
    await this.tool(
      "delete from R2",
      this.bin.aws,
      [
        "s3",
        "rm",
        "--only-show-errors",
        "--endpoint-url",
        cfg.r2.endpoint,
        `s3://${cfg.r2.bucket}/${objectKey}`,
      ],
      this.awsEnv(),
      Math.min(cfg.timeoutMs, 5 * 60_000),
      []
    );
  }
}
