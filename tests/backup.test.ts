import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "pg";
import {
  ToolsBackupProvider,
  decideBackup,
  libpqEnv,
  type Run,
  type RunResult,
  type ToolsBackupConfig,
} from "@/worker/backup";

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

const expand = (name: string) => ({ name, kind: "expand" as const });
const contract = (name: string) => ({ name, kind: "contract" as const });

describe("decideBackup", () => {
  it.each([
    ["required", [], false, /no migrations are pending/],
    ["skip_if_expand_only", [], false, /no migrations are pending/],
    ["required", [expand("a")], true, /requires a backup/],
    ["required", [expand("a"), contract("b")], true, /requires a backup/],
    ["skip_if_expand_only", [expand("a"), expand("b")], false, /only expand migrations/],
    [
      "skip_if_expand_only",
      [expand("a"), contract("20261002000000_drop")],
      true,
      /20261002000000_drop/,
    ],
    ["skip_if_expand_only", [contract("c")], true, /contract migration is pending/],
    // fails closed: anything unrecognised is treated as "required"
    ["", [expand("a")], true, /requires a backup/],
    ["SKIP_IF_EXPAND_ONLY", [expand("a")], true, /requires a backup/],
    ["skip", [expand("a")], true, /requires a backup/],
    ["skip_if_expand_only ", [expand("a")], true, /requires a backup/],
  ])("policy %j with %j: take=%s", (policy, pending, take, reason) => {
    const d = decideBackup(policy, pending);
    expect(d.take).toBe(take);
    expect(d.reason).toMatch(reason);
  });

  it("treats a migration of any kind other than expand as needing a backup", () => {
    const odd = { name: "x", kind: "something" } as never;
    expect(decideBackup("skip_if_expand_only", [odd]).take).toBe(true);
  });
});

describe("libpqEnv", () => {
  it("passes a remote database over TLS, unverified without a CA", () => {
    expect(libpqEnv("postgres://u:pw@db.example.supabase.co:5432/postgres")).toEqual({
      PGHOST: "db.example.supabase.co",
      PGPORT: "5432",
      PGUSER: "u",
      PGPASSWORD: "pw",
      PGDATABASE: "postgres",
      PGCONNECT_TIMEOUT: "15",
      PGSSLMODE: "require",
    });
  });

  it("verifies the server when a CA file is given", () => {
    const env = libpqEnv("postgres://u:pw@db.example.com/x", "/etc/ca.pem");
    expect(env).toMatchObject({ PGSSLMODE: "verify-full", PGSSLROOTCERT: "/etc/ca.pem" });
  });

  it("uses no TLS for a local database, as the worker's own connection does", () => {
    for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
      const env = libpqEnv(`postgres://u:pw@${host}:5544/x`, "/etc/ca.pem");
      expect(env.PGSSLMODE, host).toBe("disable");
      expect(env.PGSSLROOTCERT).toBeUndefined();
    }
    expect(libpqEnv("postgres://u@[::1]:5432/x").PGHOST).toBe("::1");
  });

  it("decodes percent-encoded user, password and database", () => {
    const env = libpqEnv("postgres://postgres.ref:p%40ss%2Fw%3Ard@h.example.com:6543/my%20db");
    expect(env).toMatchObject({
      PGUSER: "postgres.ref",
      PGPASSWORD: "p@ss/w:rd",
      PGDATABASE: "my db",
      PGPORT: "6543",
    });
  });

  it("defaults the port and the database", () => {
    expect(libpqEnv("postgres://u:p@h.example.com")).toMatchObject({
      PGPORT: "5432",
      PGDATABASE: "postgres",
    });
  });
});

// ---------------------------------------------------------------------------
// The provider, against a scripted command runner
// ---------------------------------------------------------------------------

const AGE_KEY = `age1${"q".repeat(58)}`;
const DB_URL = "postgres://postgres.abc:Sup3rS3cretPw@db.abc.supabase.co:5432/postgres";
const PASSWORD = "Sup3rS3cretPw";
const R2 = {
  endpoint: "https://acct.r2.cloudflarestorage.com",
  bucket: "school-backups",
  accessKeyId: "AKIAEXAMPLEKEY123",
  secretAccessKey: "r2SecretValue/abcdef123456",
};
const BACKUP_ID = "0f1e2d3c-aaaa-4bbb-8ccc-1234567890ab";
const LISTING =
  "; Archive created at 2026-10-24\n12; 2615 2200 SCHEMA - public owner\n34; 1259 16 TABLE public students owner\n";

type Call = { cmd: string; args: string[]; env: Record<string, string> };

const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "", timedOut: false });
const bad = (stderr: string, code = 1): RunResult => ({
  code,
  stdout: "",
  stderr,
  timedOut: false,
});

// Each tool is given a distinct name, so the script can tell them apart.
const BINS = { pgDump: "PGDUMP", pgRestore: "PGRESTORE", age: "AGE", aws: "AWS" };

function script(over: Partial<Record<string, (c: Call) => RunResult | Promise<RunResult>>> = {}) {
  const calls: Call[] = [];
  const encSize = { value: 5000 };
  const defaults: Record<string, (c: Call) => RunResult | Promise<RunResult>> = {
    PGDUMP: (c) => {
      const file = c.args.find((a) => a.startsWith("--file="))!.slice(7);
      writeFileSync(file, "d".repeat(4000));
      return ok();
    },
    PGRESTORE: () => ok(LISTING),
    AGE: (c) => {
      writeFileSync(c.args[c.args.indexOf("-o") + 1], "e".repeat(encSize.value));
      return ok();
    },
    AWS: (c) => {
      if (c.args[1] === "head-object") return ok(`${encSize.value}\n`);
      return ok();
    },
  };
  const run: Run = async (cmd, args, opts) => {
    const call = { cmd, args, env: opts.env };
    calls.push(call);
    return (over[cmd] ?? defaults[cmd])(call);
  };
  return { run, calls, encSize };
}

const names = (calls: Call[]) =>
  calls.map((c) => (c.cmd === "AWS" ? `AWS ${c.args[0]} ${c.args[1]}` : c.cmd));

const NOW = new Date("2026-10-24T14:05:09.123Z");

function provider(run: Run, over: Partial<ToolsBackupConfig> = {}) {
  return new ToolsBackupProvider({
    ageRecipient: AGE_KEY,
    r2: R2,
    prefix: "schools",
    timeoutMs: 30 * 60_000,
    run,
    now: () => NOW,
    bins: BINS,
    ...over,
  });
}

const req = { slug: "greenfield", backupId: BACKUP_ID, databaseUrl: DB_URL };

describe("ToolsBackupProvider (scripted tools)", () => {
  const dirs: string[] = [];
  const tmp = () => {
    const d = mkdtempSync(join(tmpdir(), "backup-test-"));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("dumps, checks, encrypts, uploads and verifies, in that order", async () => {
    const s = script();
    const out = await provider(s.run).create(req);
    expect(names(s.calls)).toEqual([
      "PGDUMP",
      "PGRESTORE",
      "AGE",
      "AWS s3 cp",
      "AWS s3api head-object",
    ]);
    expect(out.objectKey).toBe("schools/greenfield/20261024T140509Z-0f1e2d3c.dump.age");
    expect(out.sizeBytes).toBe(5000);
    expect(out.sha256).toBe(createHash("sha256").update("e".repeat(5000)).digest("hex"));
  });

  it("uploads to the bucket and endpoint it was given, under the object key it returns", async () => {
    const s = script();
    const out = await provider(s.run).create(req);
    const cp = s.calls.find((c) => c.args[1] === "cp")!;
    expect(cp.args).toContain("--endpoint-url");
    expect(cp.args[cp.args.indexOf("--endpoint-url") + 1]).toBe(R2.endpoint);
    expect(cp.args.at(-1)).toBe(`s3://school-backups/${out.objectKey}`);
    const head = s.calls.find((c) => c.args[1] === "head-object")!;
    expect(head.args[head.args.indexOf("--key") + 1]).toBe(out.objectKey);
    expect(head.args[head.args.indexOf("--bucket") + 1]).toBe("school-backups");
  });

  it("encrypts to the public key it was given and nothing else", async () => {
    const s = script();
    await provider(s.run).create(req);
    const age = s.calls.find((c) => c.cmd === "AGE")!;
    expect(age.args.slice(0, 2)).toEqual(["-r", AGE_KEY]);
    expect(age.args.filter((a) => a === "-r")).toHaveLength(1);
    expect(age.args).not.toContain("-i");
  });

  it("dumps the app, auth and migration-history schemas in the custom format, without owners", async () => {
    const s = script();
    await provider(s.run).create(req);
    const dump = s.calls[0];
    expect(dump.args).toEqual(
      expect.arrayContaining([
        "--format=custom",
        "--no-owner",
        "--no-privileges",
        "--schema=public",
        "--schema=auth",
        "--schema=supabase_migrations",
      ])
    );
    expect(dump.args.some((a) => a.startsWith("--lock-wait-timeout="))).toBe(true);
  });

  it("never puts the database URL, host or password on a command line", async () => {
    const s = script();
    await provider(s.run).create(req);
    const argv = JSON.stringify(s.calls.map((c) => c.args));
    for (const secret of [PASSWORD, "db.abc.supabase.co", "postgres://", R2.secretAccessKey]) {
      expect(argv).not.toContain(secret);
    }
  });

  it("gives each tool only the environment it needs", async () => {
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-key-should-not-leak");
    vi.stubEnv("SCHOOL_DB_URLS", '{"other":"postgres://x:other-school-pw@h/db"}');
    vi.stubEnv("R2_SECRET_ACCESS_KEY", "worker-env-r2-secret");
    const s = script();
    await provider(s.run).create(req);
    const by = Object.fromEntries(
      s.calls.map((c) => [c.cmd === "AWS" ? `AWS-${c.args[1]}` : c.cmd, c.env])
    );

    expect(by.PGDUMP).toMatchObject({ PGPASSWORD: PASSWORD, PGHOST: "db.abc.supabase.co" });
    expect(Object.keys(by.PGDUMP).some((k) => k.startsWith("AWS_"))).toBe(false);
    for (const name of ["PGRESTORE", "AGE"]) {
      expect(Object.keys(by[name]).sort(), name).not.toContain("PGPASSWORD");
    }
    expect(by["AWS-cp"]).toMatchObject({
      AWS_ACCESS_KEY_ID: R2.accessKeyId,
      AWS_SECRET_ACCESS_KEY: R2.secretAccessKey,
      AWS_DEFAULT_REGION: "auto",
    });
    expect(by["AWS-cp"].PGPASSWORD).toBeUndefined();
    // nothing else of the worker's own environment is inherited
    const everything = JSON.stringify(s.calls.map((c) => c.env));
    for (const leaked of [
      "service-role-key-should-not-leak",
      "other-school-pw",
      "worker-env-r2-secret",
    ]) {
      expect(everything).not.toContain(leaked);
    }
  });

  it("deletes the plaintext dump before uploading, and the whole temp directory afterwards", async () => {
    const base = tmp();
    let dumpPath = "";
    let plaintextAtUpload: boolean | null = null;
    const s = script({
      PGDUMP: (c) => {
        dumpPath = c.args.find((a) => a.startsWith("--file="))!.slice(7);
        writeFileSync(dumpPath, "d".repeat(4000));
        return ok();
      },
      AWS: (c) => {
        if (c.args[1] === "cp") plaintextAtUpload = existsSync(dumpPath);
        return c.args[1] === "head-object" ? ok("5000\n") : ok();
      },
    });
    await provider(s.run, { tmpDir: base }).create(req);
    expect(plaintextAtUpload).toBe(false);
    expect(existsSync(dirname(dumpPath))).toBe(false);
    expect(readdirSync(base)).toEqual([]);
  });

  it("cleans up its temp directory when it fails, too", async () => {
    const base = tmp();
    const s = script({ AGE: () => bad("age: boom") });
    await expect(provider(s.run, { tmpDir: base }).create(req)).rejects.toThrow(/age failed/);
    expect(readdirSync(base)).toEqual([]);
  });

  it("refuses an unsafe slug or backup id before running anything", async () => {
    const s = script();
    const p = provider(s.run);
    for (const slug of ["../etc", "Bad_Slug", "a", "has space", "x/y", ""]) {
      await expect(p.create({ ...req, slug }), slug).rejects.toThrow(/slug/);
    }
    await expect(p.create({ ...req, backupId: "../../x" })).rejects.toThrow(/backup id/);
    expect(s.calls).toEqual([]);
  });

  describe("failures", () => {
    it("stops at a failed pg_dump, with its error and without the password", async () => {
      const s = script({
        PGDUMP: () =>
          bad(
            `pg_dump: error: connection to server failed: password authentication failed (${PASSWORD}) for postgres://postgres.abc:${PASSWORD}@db.abc.supabase.co/postgres`
          ),
      });
      const err = await provider(s.run)
        .create(req)
        .catch((e: Error) => e);
      expect(err).toBeInstanceOf(Error);
      const text = (err as Error).message;
      expect(text).toMatch(/^pg_dump failed \(exit 1\): /);
      expect(text).toContain("password authentication failed");
      expect(text).not.toContain(PASSWORD);
      expect(text).not.toContain("postgres://");
      expect(names(s.calls)).toEqual(["PGDUMP"]);
    });

    it("reports a timeout as one", async () => {
      const s = script({
        PGDUMP: () => ({ code: null, stdout: "", stderr: "", timedOut: true }),
      });
      await expect(provider(s.run, { timeoutMs: 90 * 60_000 }).create(req)).rejects.toThrow(
        /pg_dump timed out after 90 minutes/
      );
    });

    it("rejects an empty dump even though pg_dump exited 0", async () => {
      const s = script({
        PGDUMP: (c) => {
          writeFileSync(c.args.find((a) => a.startsWith("--file="))!.slice(7), "");
          return ok();
        },
      });
      await expect(provider(s.run).create(req)).rejects.toThrow(/empty file/);
      expect(names(s.calls)).toEqual(["PGDUMP"]);
    });

    it("rejects a dump that cannot be listed", async () => {
      const s = script({ PGRESTORE: () => bad("pg_restore: error: file is not a valid archive") });
      await expect(provider(s.run).create(req)).rejects.toThrow(/pg_restore --list failed/);
      expect(names(s.calls)).toEqual(["PGDUMP", "PGRESTORE"]);
    });

    it("rejects a listing with no schema or table entries", async () => {
      const s = script({ PGRESTORE: () => ok("; Archive created at 2026-10-24\n") });
      await expect(provider(s.run).create(req)).rejects.toThrow(/not a usable backup/);
      expect(names(s.calls)).toEqual(["PGDUMP", "PGRESTORE"]);
    });

    it("rejects a suspiciously small encrypted file, before uploading", async () => {
      const s = script();
      s.encSize.value = 1024;
      await expect(provider(s.run).create(req)).rejects.toThrow(
        /suspiciously small \(1024 bytes\)/
      );
      expect(names(s.calls)).not.toContain("AWS s3 cp");
    });

    it("stops at a failed upload, scrubbing the R2 credentials from the error", async () => {
      const s = script({
        AWS: () =>
          bad(`upload failed: AccessDenied for key ${R2.accessKeyId} secret ${R2.secretAccessKey}`),
      });
      const err = (await provider(s.run)
        .create(req)
        .catch((e: Error) => e)) as Error;
      expect(err.message).toMatch(/^upload to R2 failed/);
      expect(err.message).not.toContain(R2.secretAccessKey);
      expect(err.message).not.toContain(R2.accessKeyId);
      expect(names(s.calls)).not.toContain("AWS s3api head-object");
    });

    it("fails, and deletes the object, when R2 reports a different size", async () => {
      const s = script({
        AWS: (c) => (c.args[1] === "head-object" ? ok("4999\n") : ok()),
      });
      await expect(provider(s.run).create(req)).rejects.toThrow(/R2 reports 4999 bytes.*not 5000/);
      const rm = s.calls.find((c) => c.args[1] === "rm");
      expect(rm?.args.at(-1)).toBe(
        "s3://school-backups/schools/greenfield/20261024T140509Z-0f1e2d3c.dump.age"
      );
    });

    it("fails when R2 says nothing about the object", async () => {
      const s = script({ AWS: (c) => (c.args[1] === "head-object" ? ok("") : ok()) });
      await expect(provider(s.run).create(req)).rejects.toThrow(/R2 reports no size/);
    });

    it("fails when the object cannot be checked at all", async () => {
      const s = script({
        AWS: (c) =>
          c.args[1] === "head-object"
            ? bad("An error occurred (404) when calling HeadObject")
            : ok(),
      });
      await expect(provider(s.run).create(req)).rejects.toThrow(
        /check of the uploaded backup failed/
      );
    });

    it("reports a tool that cannot be started", async () => {
      const run: Run = async () => ({
        code: null,
        stdout: "",
        stderr: "spawn pg_dump ENOENT",
        timedOut: false,
      });
      await expect(provider(run).create(req)).rejects.toThrow(
        /pg_dump failed \(exit none\): spawn pg_dump ENOENT/
      );
    });

    it("clips a very long error", async () => {
      const s = script({ PGDUMP: () => bad("x".repeat(5000)) });
      const err = (await provider(s.run)
        .create(req)
        .catch((e: Error) => e)) as Error;
      expect(err.message.length).toBeLessThan(800);
    });
  });

  describe("remove", () => {
    it("deletes a backup object it could have made", async () => {
      const s = script();
      await provider(s.run).remove("schools/greenfield/20261024T140509Z-0f1e2d3c.dump.age");
      expect(s.calls).toHaveLength(1);
      expect(s.calls[0].args.slice(0, 2)).toEqual(["s3", "rm"]);
      expect(s.calls[0].args.at(-1)).toBe(
        "s3://school-backups/schools/greenfield/20261024T140509Z-0f1e2d3c.dump.age"
      );
    });

    it.each([
      ["another prefix", "other/greenfield/a.dump.age"],
      ["a prefix lookalike", "schools-evil/greenfield/a.dump.age"],
      ["a path trick", "schools/../control-plane/a.dump.age"],
      ["a doubled slash", "schools//a.dump.age"],
      ["a different suffix", "schools/greenfield/a.dump"],
      ["a bare prefix", "schools/"],
      ["a wildcard", "schools/greenfield/*.dump.age"],
      ["a space", "schools/green field/a.dump.age"],
      ["an empty key", ""],
    ])("refuses %s", async (_n, key) => {
      const s = script();
      await expect(provider(s.run).remove(key)).rejects.toThrow(/not one of this worker's backups/);
      expect(s.calls).toEqual([]);
    });

    it("reports a failed delete", async () => {
      const s = script({ AWS: () => bad("AccessDenied") });
      await expect(provider(s.run).remove("schools/greenfield/a.dump.age")).rejects.toThrow(
        /delete from R2 failed/
      );
    });
  });

  describe("setup", () => {
    it.each([
      [
        "a private age key",
        { ageRecipient: "AGE-SECRET-KEY-1QQQQQQQQQQQQQQQQQQQQQQQQQQQ" },
        /age public key/,
      ],
      ["a key that is too short", { ageRecipient: "age1abc" }, /age public key/],
      ["a prefix with ..", { prefix: "a/../b" }, /PREFIX/],
      ["a prefix ending in a slash", { prefix: "schools/" }, /PREFIX/],
      ["an empty prefix", { prefix: "" }, /PREFIX/],
    ])("refuses %s", (_n, over, message) => {
      expect(() => provider(script().run, over as Partial<ToolsBackupConfig>)).toThrow(message);
    });

    it("uses a nested prefix as given", async () => {
      const s = script();
      const out = await provider(s.run, { prefix: "team-a/schools" }).create(req);
      expect(out.objectKey.startsWith("team-a/schools/greenfield/")).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// The real tools: pg_dump, age and the aws CLI against a throwaway database and
// a local S3-compatible server. Needs RUNNER_TEST_PG and BACKUP_TEST_S3_ENDPOINT
// (for example moto_server) plus pg_dump, pg_restore, age and aws on the PATH.
// ---------------------------------------------------------------------------

const ADMIN_URL = process.env.RUNNER_TEST_PG;
const S3_ENDPOINT = process.env.BACKUP_TEST_S3_ENDPOINT;
const haveTool = (cmd: string) => spawnSync(cmd, ["--version"]).status === 0;
const TOOLS = ["pg_dump", "pg_restore", "age", "age-keygen", "aws"].every(haveTool);

describe.skipIf(!ADMIN_URL || !S3_ENDPOINT || !TOOLS)(
  "backups with the real tools (pg_dump, age, aws against a local S3 server)",
  () => {
    const BUCKET = `backup-test-${Date.now()}`;
    const MARKER = "PLAINTEXT-MARKER-4f9a1c";
    const awsEnv = {
      ...process.env,
      AWS_ACCESS_KEY_ID: "test",
      AWS_SECRET_ACCESS_KEY: "test-secret-value",
      AWS_DEFAULT_REGION: "auto",
    } as Record<string, string>;
    const aws = (...args: string[]) =>
      spawnSync("aws", ["--endpoint-url", S3_ENDPOINT!, ...args], {
        env: awsEnv as NodeJS.ProcessEnv,
        encoding: "utf8",
      });

    let admin: Client;
    const created: string[] = [];
    let work: string;
    let keyFile: string;
    let publicKey: string;
    const dbUrl = (name: string) => ADMIN_URL!.replace(/\/[^/]*$/, `/${name}`);
    const newDb = async (prefix: string) => {
      const name = `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
      await admin.query(`create database ${name}`);
      created.push(name);
      return name;
    };
    const real = (tmpDir: string, over: Partial<ToolsBackupConfig> = {}) =>
      new ToolsBackupProvider({
        ageRecipient: publicKey,
        r2: {
          endpoint: S3_ENDPOINT!,
          bucket: BUCKET,
          accessKeyId: "test",
          secretAccessKey: "test-secret-value",
        },
        prefix: "schools",
        timeoutMs: 120_000,
        tmpDir,
        ...over,
      });

    beforeAll(async () => {
      admin = new Client({ connectionString: ADMIN_URL });
      await admin.connect();
      work = mkdtempSync(join(tmpdir(), "backup-real-"));
      keyFile = join(work, "key.txt");
      const gen = spawnSync("age-keygen", ["-o", keyFile], { encoding: "utf8" });
      publicKey = /(age1[0-9a-z]+)/.exec(`${gen.stdout}${gen.stderr}`)![1];
      expect(aws("s3", "mb", `s3://${BUCKET}`).status).toBe(0);
    });
    afterAll(async () => {
      for (const name of created) await admin.query(`drop database if exists ${name} with (force)`);
      await admin.end();
      rmSync(work, { recursive: true, force: true });
    });

    async function seededSchool() {
      const name = await newDb("school_src");
      const c = new Client({ connectionString: dbUrl(name) });
      await c.connect();
      await c.query(`
        create schema auth; create schema supabase_migrations;
        create table auth.users (id int primary key, email text);
        create table supabase_migrations.schema_migrations (version text primary key);
        create table public.students (id int primary key, name text);
        insert into auth.users values (1, 'teacher@example.com');
        insert into supabase_migrations.schema_migrations values ('20261001000000');
        insert into public.students values (1, '${MARKER}'), (2, 'Ada'), (3, 'Grace');
      `);
      await c.end();
      return name;
    }
    const objects = (prefix = "schools/") => {
      const r = aws(
        "s3api",
        "list-objects-v2",
        "--bucket",
        BUCKET,
        "--prefix",
        prefix,
        "--query",
        "Contents[].Key",
        "--output",
        "text"
      );
      const t = r.stdout.trim();
      return t && t !== "None" ? t.split(/\s+/) : [];
    };

    it("round-trips a real school database: dump, encrypt, upload, then decrypt and restore it elsewhere", async () => {
      const src = await seededSchool();
      const tmpDir = mkdtempSync(join(work, "tmp-"));
      const out = await real(tmpDir).create({
        slug: "greenfield",
        backupId: BACKUP_ID,
        databaseUrl: dbUrl(src),
      });

      expect(out.objectKey).toMatch(/^schools\/greenfield\/\d{8}T\d{6}Z-0f1e2d3c\.dump\.age$/);
      expect(out.sizeBytes).toBeGreaterThan(1024);
      expect(objects()).toContain(out.objectKey);
      expect(readdirSync(tmpDir)).toEqual([]); // no plaintext left behind

      // download what R2 holds: it is exactly what we recorded...
      const stored = join(work, "stored.dump.age");
      expect(
        aws("s3", "cp", "--only-show-errors", `s3://${BUCKET}/${out.objectKey}`, stored).status
      ).toBe(0);
      const bytes = readFileSync(stored);
      expect(bytes.length).toBe(out.sizeBytes);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(out.sha256);
      // ...and it is encrypted: the data is not in it
      expect(bytes.includes(Buffer.from(MARKER))).toBe(false);

      // the right key opens it; a different key does not
      const plain = join(work, "restored.dump");
      expect(spawnSync("age", ["-d", "-i", keyFile, "-o", plain, stored]).status).toBe(0);
      const otherKey = join(work, "other.txt");
      spawnSync("age-keygen", ["-o", otherKey]);
      expect(
        spawnSync("age", ["-d", "-i", otherKey, "-o", join(work, "nope"), stored]).status
      ).not.toBe(0);

      // restore into a fresh database and compare the data
      const dst = await newDb("school_dst");
      const restore = spawnSync(
        "pg_restore",
        ["--no-owner", "--clean", "--if-exists", "-d", dbUrl(dst), plain],
        {
          encoding: "utf8",
        }
      );
      expect(restore.status, restore.stderr).toBe(0);
      const c = new Client({ connectionString: dbUrl(dst) });
      await c.connect();
      expect(
        (await c.query("select name from public.students order by id")).rows.map((r) => r.name)
      ).toEqual([MARKER, "Ada", "Grace"]);
      expect((await c.query("select email from auth.users")).rows[0].email).toBe(
        "teacher@example.com"
      );
      expect(
        (await c.query("select version from supabase_migrations.schema_migrations")).rows[0].version
      ).toBe("20261001000000");
      await c.end();

      // removing it removes exactly that object
      await real(tmpDir).remove(out.objectKey);
      expect(objects()).not.toContain(out.objectKey);
    });

    it("leaves no object and no files behind when the database cannot be dumped", async () => {
      const before = objects();
      const tmpDir = mkdtempSync(join(work, "tmp-"));
      const err = (await real(tmpDir)
        .create({
          slug: "redfield",
          backupId: BACKUP_ID,
          databaseUrl: dbUrl("no_such_database_xyz"),
        })
        .catch((e: Error) => e)) as Error;
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toMatch(/^pg_dump failed/);
      expect(objects()).toEqual(before);
      expect(readdirSync(tmpDir)).toEqual([]);
    });

    it("fails, uploading nothing, when the bucket does not exist", async () => {
      const src = await seededSchool();
      const tmpDir = mkdtempSync(join(work, "tmp-"));
      const p = real(tmpDir, {
        r2: {
          endpoint: S3_ENDPOINT!,
          bucket: "no-such-bucket-xyz",
          accessKeyId: "test",
          secretAccessKey: "test-secret-value",
        },
      });
      await expect(
        p.create({ slug: "greenfield", backupId: BACKUP_ID, databaseUrl: dbUrl(src) })
      ).rejects.toThrow(/upload to R2 failed/);
      expect(readdirSync(tmpDir)).toEqual([]);
    });

    it("will not delete an object outside its own prefix, even one that exists", async () => {
      const f = join(work, "other.dump.age");
      writeFileSync(f, "x");
      expect(
        aws("s3", "cp", "--only-show-errors", f, `s3://${BUCKET}/control-plane/keep-me.dump.age`)
          .status
      ).toBe(0);
      await expect(real(work).remove("control-plane/keep-me.dump.age")).rejects.toThrow(
        /not one of/
      );
      expect(objects("control-plane/")).toEqual(["control-plane/keep-me.dump.age"]);
    });
  }
);
