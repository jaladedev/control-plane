import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Runs scripts/restore-drill.sh for real: pg_dump, age, pg_restore and psql against
// a scratch Postgres. Skipped without RUNNER_TEST_PG or without those programs.

const ADMIN_URL = process.env.RUNNER_TEST_PG;
const have = (cmd: string) => spawnSync("which", [cmd]).status === 0;
const TOOLS = ["pg_dump", "pg_restore", "psql", "age", "age-keygen"].every(have);
const SCRIPT = resolve("scripts/restore-drill.sh");

describe.skipIf(!ADMIN_URL || !TOOLS)("restore drill script", () => {
  const work = mkdtempSync(join(tmpdir(), "drill-test-"));
  const suffix = randomBytes(4).toString("hex");
  const url = new URL(ADMIN_URL ?? "postgresql://x@localhost/postgres");
  const pg = {
    PGHOST: url.hostname,
    PGPORT: url.port || "5432",
    PGUSER: decodeURIComponent(url.username),
    ...(url.password ? { PGPASSWORD: decodeURIComponent(url.password) } : {}),
  };
  const srcName = `drill_src_${suffix}`;
  const srcUrl = `postgresql://${pg.PGUSER}@${pg.PGHOST}:${pg.PGPORT}/${srcName}`;
  let keyFile = "";
  let otherKey = "";
  let enc = "";
  let sha = "";
  let encNoHistory = "";
  let shaNoHistory = "";

  const admin = () => new Client({ connectionString: ADMIN_URL });
  const scratchDatabases = async () => {
    const c = admin();
    await c.connect();
    const { rows } = await c.query(
      "select datname from pg_database where datname like 'drill\\_2%'"
    );
    await c.end();
    return rows.map((r) => r.datname as string);
  };
  const sh = (cmd: string, args: string[], env: Record<string, string> = {}) => {
    const r = spawnSync(cmd, args, {
      env: { PATH: process.env.PATH ?? "", NODE_ENV: "test", ...pg, ...env },
      encoding: "utf8",
    });
    if (r.status !== 0) throw new Error(`${cmd} failed: ${r.stderr}`);
    return r.stdout;
  };
  const keygen = (file: string) => {
    const out = spawnSync("age-keygen", ["-o", file], { encoding: "utf8" });
    return /age1[a-z0-9]+/.exec(out.stderr + out.stdout)![0];
  };
  const encrypt = (dump: string, pub: string) => {
    const out = `${dump}.age`;
    sh("age", ["-r", pub, "-o", out, dump]);
    return { out, sha: createHash("sha256").update(readFileSync(out)).digest("hex") };
  };

  beforeAll(async () => {
    const c = admin();
    await c.connect();
    await c.query(`create database "${srcName}"`);
    await c.end();
    const s = new Client({ connectionString: srcUrl });
    await s.connect();
    await s.query(`
      create table public.profiles (id int primary key, full_name text);
      create table public.school_settings (id int primary key);
      insert into public.profiles values (1, 'Ada'), (2, 'Bayo'), (3, 'Chi');
      insert into public.school_settings values (1);
      create schema supabase_migrations;
      create table supabase_migrations.schema_migrations (version text primary key, name text);
      insert into supabase_migrations.schema_migrations values ('20260101000000', 'init'), ('20260202000000', 'more');
    `);
    await s.end();

    keyFile = join(work, "key.txt");
    otherKey = join(work, "other.txt");
    const pub = keygen(keyFile);
    keygen(otherKey);

    const dump = join(work, "school.dump");
    sh("pg_dump", [
      "--format=custom",
      "--no-owner",
      "-n",
      "public",
      "-n",
      "supabase_migrations",
      "-f",
      dump,
      srcName,
    ]);
    ({ out: enc, sha } = encrypt(dump, pub));

    const dump2 = join(work, "nohistory.dump");
    sh("pg_dump", ["--format=custom", "--no-owner", "-n", "public", "-f", dump2, srcName]);
    ({ out: encNoHistory, sha: shaNoHistory } = encrypt(dump2, pub));
  });

  afterAll(async () => {
    const c = admin();
    await c.connect();
    await c.query(`drop database if exists "${srcName}"`);
    await c.end();
    rmSync(work, { recursive: true, force: true });
  });

  const drill = (env: Record<string, string>) => {
    const tmp = mkdtempSync(join(work, "tmp-"));
    const r = spawnSync("bash", [SCRIPT], {
      env: { PATH: process.env.PATH ?? "", NODE_ENV: "test", TMPDIR: tmp, ...pg, ...env },
      encoding: "utf8",
    });
    const last = r.stdout
      .trim()
      .split("\n")
      .filter((l) => l.startsWith("DRILL "))
      .pop();
    return {
      code: r.status,
      out: r.stdout,
      err: r.stderr,
      tmp,
      result: last ? JSON.parse(last.slice(6)) : null,
    };
  };
  const base = () => ({ AGE_IDENTITY: keyFile, DRILL_FILE: enc, EXPECTED_SHA256: sha });

  it("restores a school backup into a scratch database and reports what it found", async () => {
    const r = drill(base());
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.result).toMatchObject({
      ok: true,
      tables: 2,
      latest_migration: "20260202000000",
      restore_errors: 0,
    });
    expect(r.out).toMatch(/PASSED in \d+s: 2 tables restored/);
    for (const step of ["checksum", "decrypt", "list", "restore", "check"])
      expect(r.out).toContain(`${step}:`);
  });

  it("leaves no scratch database and no plaintext dump behind", async () => {
    const r = drill(base());
    expect(r.code).toBe(0);
    expect(await scratchDatabases()).toEqual([]);
    expect(readdirSync(r.tmp)).toEqual([]);
  });

  it("cleans up even when it fails after restoring", async () => {
    const r = drill({ ...base(), KIND: "control-plane" });
    expect(r.code).toBe(1);
    expect(r.result.reason).toMatch(/no table dashboard_users/);
    expect(await scratchDatabases()).toEqual([]);
    expect(readdirSync(r.tmp)).toEqual([]);
  });

  it("refuses a file whose checksum is not the recorded one, before decrypting anything", async () => {
    const r = drill({ ...base(), EXPECTED_SHA256: "0".repeat(64) });
    expect(r.code).toBe(1);
    expect(r.result.reason).toMatch(/checksum mismatch/);
    expect(r.out).not.toContain("Decrypting");
    expect(await scratchDatabases()).toEqual([]);
  });

  it("refuses the wrong key", () => {
    const r = drill({ ...base(), AGE_IDENTITY: otherKey });
    expect(r.code).toBe(1);
    expect(r.result.reason).toMatch(/could not decrypt/);
    expect(r.out).not.toContain("Restoring");
  });

  it("refuses a file that is not an encrypted dump", () => {
    const junk = join(work, "junk.dump.age");
    writeFileSync(junk, "not a backup");
    const r = drill({
      ...base(),
      DRILL_FILE: junk,
      EXPECTED_SHA256: createHash("sha256").update("not a backup").digest("hex"),
    });
    expect(r.code).toBe(1);
    expect(r.result.reason).toMatch(/could not decrypt/);
  });

  it.each(["db.abcdefgh.supabase.co", "aws-0-eu-west-1.pooler.supabase.com", "x.supabase.com"])(
    "never restores onto %s",
    (host) => {
      const r = drill({ ...base(), PGHOST: host });
      expect(r.code).toBe(1);
      expect(r.result.reason).toMatch(/Supabase host/);
      expect(r.out).not.toContain("Checking the checksum");
    }
  );

  it("fails a school dump that has no migration history", async () => {
    const r = drill({ ...base(), DRILL_FILE: encNoHistory, EXPECTED_SHA256: shaNoHistory });
    expect(r.code).toBe(1);
    expect(r.result.reason).toMatch(/no migration history/);
    expect(await scratchDatabases()).toEqual([]);
  });

  it("requires a recorded checksum, a key and a file", () => {
    expect(drill({ ...base(), EXPECTED_SHA256: "" }).code).not.toBe(0);
    expect(drill({ ...base(), AGE_IDENTITY: join(work, "nope.txt") }).result.reason).toMatch(
      /AGE_IDENTITY/
    );
    expect(drill({ AGE_IDENTITY: keyFile, EXPECTED_SHA256: sha }).code).not.toBe(0);
    expect(drill({ ...base(), EXPECTED_SHA256: "xyz" }).result.reason).toMatch(/64 lowercase hex/);
    expect(drill({ ...base(), KIND: "other" }).result.reason).toMatch(/KIND/);
  });

  it("shows row counts beside the live source, and a moved-on source is not a failure", async () => {
    const s = new Client({ connectionString: srcUrl });
    await s.connect();
    await s.query("insert into public.profiles values (4, 'Dayo')");
    await s.end();
    const r = drill({ ...base(), SOURCE_URL: srcUrl });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/profiles\s+3\s+4\s+1/);
    expect(r.out).toMatch(/school_settings\s+1\s+1\s+0/);
  });

  it("never prints the key or the source address with its password", () => {
    const r = drill({ ...base(), SOURCE_URL: srcUrl });
    expect(r.out + r.err).not.toContain(
      readFileSync(keyFile, "utf8")
        .split("\n")
        .find((l) => l.startsWith("AGE-SECRET-KEY"))!
    );
  });
});
