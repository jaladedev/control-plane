import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";
import { checksumOf } from "@/lib/migrate/parse";
import {
  MigrationError,
  applyPendingMigrations,
  type RunRecorder,
  type RunnerMigration,
} from "@/lib/migrate/runner";

// Runs the runner against throwaway Postgres databases (plan section 10).
// Set RUNNER_TEST_PG to a superuser connection string, for example
//   postgres://postgres@127.0.0.1:5432/postgres
// Without it these tests are skipped.
const ADMIN_URL = process.env.RUNNER_TEST_PG;

const TAG_OLD = "1".repeat(40);
const TAG_NEW = "2".repeat(40);
const SEQ: Record<string, number> = { [TAG_OLD]: 1, [TAG_NEW]: 2 };
const appSeq = (tag: string | null) => (tag && tag in SEQ ? SEQ[tag] : null);

let n = 0;
function mig(version: string, sql: string, extra: Partial<RunnerMigration> = {}): RunnerMigration {
  return {
    id: `id-${version}`,
    version,
    name: `${version}_m${n++}`,
    sql,
    checksum: checksumOf(sql),
    kind: "expand",
    minAppVersion: null,
    releaseSeq: 1,
    ...extra,
  };
}

function recorder() {
  const runs: { id: string; version: string; status: string; error?: string }[] = [];
  const r: RunRecorder = {
    start: async (m) => {
      runs.push({ id: `run-${runs.length}`, version: m.version, status: "running" });
      return `run-${runs.length - 1}`;
    },
    finish: async (id, ok, error) => {
      const run = runs[Number(id.split("-")[1])];
      run.status = ok ? "succeeded" : "failed";
      run.error = error;
    },
  };
  return { r, runs };
}

describe.skipIf(!ADMIN_URL)("migration runner (real Postgres)", () => {
  let admin: Client;
  let db: Client;
  let dbName: string;

  const input = (registered: RunnerMigration[], rec: RunRecorder, extra = {}) => ({
    db,
    registered,
    targetSeq: 1,
    currentTag: TAG_OLD,
    appSeq,
    recorder: rec,
    ...extra,
  });
  const q = async (sql: string) => (await db.query(sql)).rows;
  const tables = async () =>
    (
      await q(
        "select table_name from information_schema.tables where table_schema = 'public' order by 1"
      )
    ).map((r) => String(r.table_name));
  const appliedVersions = async () =>
    (await q("select version from supabase_migrations.schema_migrations order by 1")).map((r) =>
      String(r.version)
    );

  beforeAll(async () => {
    admin = new Client({ connectionString: ADMIN_URL });
    await admin.connect();
  });
  afterAll(async () => {
    await admin.end();
  });
  beforeEach(async () => {
    if (db) await db.end().catch(() => {});
    if (dbName) await admin.query(`drop database if exists ${dbName} with (force)`);
    dbName = `runner_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    await admin.query(`create database ${dbName}`);
    db = new Client({ connectionString: ADMIN_URL!.replace(/\/[^/]*$/, `/${dbName}`) });
    await db.connect();
  });

  it("applies pending migrations in version order and records each one", async () => {
    const { r, runs } = recorder();
    const out = await applyPendingMigrations(
      input(
        [
          mig("20261003000000", "create table c (id int);"),
          mig("20261001000000", "create table a (id int);"),
          mig("20261002000000", "create table b (id int);"),
        ],
        r
      )
    );
    expect(out.applied.map((a) => a.slice(0, 14))).toEqual([
      "20261001000000",
      "20261002000000",
      "20261003000000",
    ]);
    expect(await tables()).toEqual(["a", "b", "c"]);
    expect(await appliedVersions()).toEqual(["20261001000000", "20261002000000", "20261003000000"]);
    expect(runs.map((x) => x.status)).toEqual(["succeeded", "succeeded", "succeeded"]);
    expect(out.latestVersion).toBe("20261003000000");
  });

  it("is idempotent: a second run applies nothing", async () => {
    const registered = [
      mig("20261001000000", "create table a (id int);"),
      mig("20261002000000", "create table b (id int);"),
    ];
    await applyPendingMigrations(input(registered, recorder().r));
    const { r, runs } = recorder();
    const again = await applyPendingMigrations(input(registered, r));
    expect(again.applied).toEqual([]);
    expect(again.alreadyApplied).toBe(2);
    expect(runs).toEqual([]);
  });

  it("applies only what is missing when the school is partly migrated", async () => {
    const first = mig("20261001000000", "create table a (id int);");
    const second = mig("20261002000000", "create table b (id int);");
    await applyPendingMigrations(input([first], recorder().r));
    const out = await applyPendingMigrations(input([first, second], recorder().r));
    expect(out.applied).toEqual([second.name]);
    expect(await tables()).toEqual(["a", "b"]);
  });

  it("stops at the first failure, rolls that migration back completely, and leaves later ones alone", async () => {
    const { r, runs } = recorder();
    const registered = [
      mig("20261001000000", "create table ok_one (id int);"),
      mig("20261002000000", "create table half_done (id int); select 1/0;"),
      mig("20261003000000", "create table never (id int);"),
    ];
    const error = await applyPendingMigrations(input(registered, r)).catch((e) => e);
    expect(error).toBeInstanceOf(MigrationError);
    expect(error.message).toMatch(/failed: division by zero/);
    expect(error.applied).toEqual([registered[0].name]);
    expect(error.failedMigration).toBe(registered[1].name);
    // the school really is at the first migration now; the error says so
    expect(error.latestVersion).toBe("20261001000000");
    expect(await tables()).toEqual(["ok_one"]); // half_done rolled back, never not attempted
    expect(await appliedVersions()).toEqual(["20261001000000"]);
    expect(runs.map((x) => x.status)).toEqual(["succeeded", "failed"]);
    expect(runs[1].error).toMatch(/division by zero/);
  });

  it("can be re-run after fixing the failure, continuing where it stopped", async () => {
    const good = mig("20261001000000", "create table a (id int);");
    const broken = mig("20261002000000", "select 1/0;");
    await applyPendingMigrations(input([good, broken], recorder().r)).catch(() => {});
    const fixed = mig("20261002000000", "create table b (id int);");
    const out = await applyPendingMigrations(input([good, fixed], recorder().r));
    expect(out.applied).toEqual([fixed.name]);
    expect(await tables()).toEqual(["a", "b"]);
  });

  it("reports the school's real latest version even when a refusal happens before anything runs", async () => {
    const first = mig("20261001000000", "create table a (id int);");
    await applyPendingMigrations(input([first], recorder().r));
    const contract = mig("20261002000000", "create table b (id int);", {
      kind: "contract",
      minAppVersion: TAG_NEW,
    });
    const error = await applyPendingMigrations(input([first, contract], recorder().r)).catch(
      (e) => e
    );
    expect(error).toBeInstanceOf(MigrationError);
    expect(error.latestVersion).toBe("20261001000000");
  });

  it("refuses a school that has a migration the registry does not know", async () => {
    await db.query("create schema supabase_migrations");
    await db.query(
      "create table supabase_migrations.schema_migrations (version text primary key, statements text[], name text)"
    );
    await db.query(
      "insert into supabase_migrations.schema_migrations (version, name) values ('20250101000000', 'mystery')"
    );
    const { r, runs } = recorder();
    const error = await applyPendingMigrations(
      input([mig("20261001000000", "create table a (id int);")], r)
    ).catch((e) => e);
    expect(error).toBeInstanceOf(MigrationError);
    expect(error.message).toMatch(/does not know: 20250101000000/);
    expect(await tables()).toEqual([]);
    expect(runs).toEqual([]);
  });

  it("refuses to apply a migration older than the newest the school has", async () => {
    const newer = mig("20261005000000", "create table newer (id int);");
    await applyPendingMigrations(input([newer], recorder().r));
    const older = mig("20261001000000", "create table older (id int);");
    const error = await applyPendingMigrations(input([older, newer], recorder().r)).catch((e) => e);
    expect(error.message).toMatch(/out of order/);
    expect(await tables()).toEqual(["newer"]);
  });

  describe("contract migrations", () => {
    const expand = mig("20261001000000", "create table a (id int);");
    const contract = (min: string | null) =>
      mig("20261002000000", "create table b (id int);", {
        kind: "contract",
        minAppVersion: min,
        releaseSeq: 1,
      });

    it("is refused when the school runs an older app, and nothing before it is applied either", async () => {
      const { r, runs } = recorder();
      const error = await applyPendingMigrations(
        input([expand, contract(TAG_NEW)], r, { currentTag: TAG_OLD })
      ).catch((e) => e);
      expect(error).toBeInstanceOf(MigrationError);
      expect(error.message).toMatch(/contract migration that needs app version/);
      expect(error.applied).toEqual([]);
      expect(await tables()).toEqual([]);
      expect(runs).toEqual([]);
    });

    it("is applied when the school already runs the required app version", async () => {
      const out = await applyPendingMigrations(
        input([expand, contract(TAG_NEW)], recorder().r, { currentTag: TAG_NEW })
      );
      expect(out.applied).toHaveLength(2);
    });

    it("is applied when the school runs a newer app than required", async () => {
      const out = await applyPendingMigrations(
        input([contract(TAG_OLD)], recorder().r, { currentTag: TAG_NEW })
      );
      expect(out.applied).toHaveLength(1);
    });

    it("is refused when the school's app version is unknown", async () => {
      const error = await applyPendingMigrations(
        input([contract(TAG_OLD)], recorder().r, { currentTag: "9".repeat(40) })
      ).catch((e) => e);
      expect(error.message).toMatch(/Deploy the newer app first/);
      const none = await applyPendingMigrations(
        input([contract(TAG_OLD)], recorder().r, { currentTag: null })
      ).catch((e) => e);
      expect(none).toBeInstanceOf(MigrationError);
    });

    it("is refused when its required release is not registered", async () => {
      const error = await applyPendingMigrations(
        input([contract("9".repeat(40))], recorder().r, { currentTag: TAG_NEW })
      ).catch((e) => e);
      expect(error).toBeInstanceOf(MigrationError);
    });

    it("does not stop an already-applied contract migration from being skipped", async () => {
      const c = contract(TAG_NEW);
      await applyPendingMigrations(input([c], recorder().r, { currentTag: TAG_NEW }));
      const out = await applyPendingMigrations(input([c], recorder().r, { currentTag: TAG_OLD }));
      expect(out.applied).toEqual([]);
    });
  });

  it("applies only migrations registered up to the target release", async () => {
    const early = mig("20261001000000", "create table early (id int);", { releaseSeq: 1 });
    const late = mig("20261002000000", "create table late (id int);", { releaseSeq: 2 });
    const out = await applyPendingMigrations(input([early, late], recorder().r, { targetSeq: 1 }));
    expect(out.applied).toEqual([early.name]);
    expect(await tables()).toEqual(["early"]);
  });

  it("refuses SQL that does not match its checksum", async () => {
    const m = {
      ...mig("20261001000000", "create table a (id int);"),
      checksum: checksumOf("something else"),
    };
    const error = await applyPendingMigrations(input([m], recorder().r)).catch((e) => e);
    expect(error.message).toMatch(/does not match its checksum/);
    expect(await tables()).toEqual([]);
  });

  it("runs a file that wraps itself in BEGIN/COMMIT, and still rolls back on failure", async () => {
    const wrapped = mig(
      "20261001000000",
      "begin;\ncreate table w1 (id int);\ncreate table w2 (id int);\ncommit;\n"
    );
    const out = await applyPendingMigrations(input([wrapped], recorder().r));
    expect(out.applied).toEqual([wrapped.name]);
    expect(await tables()).toEqual(["w1", "w2"]);

    const failing = mig(
      "20261002000000",
      "begin;\ncreate table w3 (id int);\nselect 1/0;\ncommit;\n"
    );
    const error = await applyPendingMigrations(input([wrapped, failing], recorder().r)).catch(
      (e) => e
    );
    expect(error).toBeInstanceOf(MigrationError);
    expect(await tables()).toEqual(["w1", "w2"]);
    expect(await appliedVersions()).toEqual(["20261001000000"]);
  });

  it("holds a per-database lock so two runs cannot overlap", async () => {
    const other = new Client({ connectionString: ADMIN_URL!.replace(/\/[^/]*$/, `/${dbName}`) });
    await other.connect();
    await other.query("select pg_advisory_lock(7234001)");
    try {
      const { r, runs } = recorder();
      const error = await applyPendingMigrations(
        input([mig("20261001000000", "create table a (id int);")], r)
      ).catch((e) => e);
      expect(error.message).toMatch(/holds this school's database lock/);
      expect(runs).toEqual([]);
    } finally {
      await other.query("select pg_advisory_unlock(7234001)");
      await other.end();
    }
    const out = await applyPendingMigrations(
      input([mig("20261001000000", "create table a (id int);")], recorder().r)
    );
    expect(out.applied).toHaveLength(1);
  });

  it("releases the lock even when a migration fails", async () => {
    await applyPendingMigrations(input([mig("20261001000000", "select 1/0;")], recorder().r)).catch(
      () => {}
    );
    const rows = await q("select pg_try_advisory_lock(7234001) as ok");
    expect(rows[0].ok).toBe(true);
  });

  it("works against the Supabase CLI's own table, with its extra columns", async () => {
    await db.query("create schema supabase_migrations");
    await db.query(
      "create table supabase_migrations.schema_migrations (version text not null primary key, statements text[], name text, created_by text, idempotency_key text unique)"
    );
    const out = await applyPendingMigrations(
      input([mig("20261001000000", "create table a (id int);")], recorder().r)
    );
    expect(out.applied).toHaveLength(1);
    expect(await appliedVersions()).toEqual(["20261001000000"]);
  });

  it("does not refuse to continue when recording the finish fails after a commit", async () => {
    const r: RunRecorder = {
      start: async () => "run-0",
      finish: async () => {
        throw new Error("control plane unreachable");
      },
    };
    const out = await applyPendingMigrations(
      input([mig("20261001000000", "create table a (id int);")], r)
    );
    expect(out.applied).toHaveLength(1);
    expect(await tables()).toEqual(["a"]);
  });

  it("applies nothing when it cannot record the start", async () => {
    const r: RunRecorder = {
      start: async () => {
        throw new Error("control plane unreachable");
      },
      finish: async () => {},
    };
    await expect(
      applyPendingMigrations(input([mig("20261001000000", "create table a (id int);")], r))
    ).rejects.toThrow(/unreachable/);
    expect(await tables()).toEqual([]);
  });

  it("migrates an empty database from nothing", async () => {
    const out = await applyPendingMigrations(input([], recorder().r));
    expect(out).toEqual({ applied: [], alreadyApplied: 0, latestVersion: null });
  });
});
