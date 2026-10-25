import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";
import { adoptSchool, planAdoption } from "@/lib/migrate/adopt";
import { checksumOf } from "@/lib/migrate/parse";
import {
  LOCK_KEY,
  applyPendingMigrations,
  readAppliedVersionsReadOnly,
  type RunnerMigration,
} from "@/lib/migrate/runner";

const reg = (...versions: string[]) => versions.map((v) => ({ version: v, name: `${v}_m` }));
const V1 = "20260101000000";
const V2 = "20260201000000";
const V3 = "20260301000000";

describe("planAdoption", () => {
  it("records every registered migration up to --through that the school does not have, in order", () => {
    const plan = planAdoption(reg(V3, V1, V2), [], V2);
    expect(plan.errors).toEqual([]);
    expect(plan.toRecord.map((m) => m.version)).toEqual([V1, V2]);
    expect(plan.alreadyRecorded).toBe(0);
  });

  it("skips what the school already records, and says how many", () => {
    const plan = planAdoption(reg(V1, V2, V3), [V1], V2);
    expect(plan.toRecord.map((m) => m.version)).toEqual([V2]);
    expect(plan.alreadyRecorded).toBe(1);
  });

  it("has nothing to do for a fully recorded school", () => {
    const plan = planAdoption(reg(V1, V2), [V1, V2], V2);
    expect(plan).toEqual({ toRecord: [], alreadyRecorded: 2, errors: [] });
  });

  it("refuses a --through that is not a registered version, or not a version at all", () => {
    expect(planAdoption(reg(V1, V2), [], "20260150000000").errors[0]).toMatch(
      /not a registered migration version/
    );
    expect(planAdoption(reg(V1), [], "soon").errors[0]).toMatch(/14-digit/);
    expect(planAdoption(reg(V1, V2), [], "20260150000000").toRecord).toEqual([]);
  });

  it("refuses a school whose table records migrations the control plane does not know", () => {
    const plan = planAdoption(reg(V1, V2), ["20250101000000", V1], V2);
    expect(plan.errors[0]).toMatch(/does not know \(20250101000000\)/);
    expect(plan.errors[0]).toMatch(/diverged/);
    expect(plan.toRecord).toEqual([]);
  });

  it("refuses --through older than what the school already records, and says what to use", () => {
    const plan = planAdoption(reg(V1, V2, V3), [V3], V1);
    expect(plan.errors[0]).toMatch(
      new RegExp(`already records ${V3}.*Use --through ${V3} or later`)
    );
  });
});

// Real Postgres, like the runner tests. RUNNER_TEST_PG: a superuser connection string.
const ADMIN_URL = process.env.RUNNER_TEST_PG;
const dbUrl = (name: string) => ADMIN_URL!.replace(/\/[^/]*$/, `/${name}`);

describe.skipIf(!ADMIN_URL)("adoptSchool (real Postgres)", () => {
  let admin: Client;
  let db: Client;
  let name: string;
  const created: string[] = [];

  const table = async () =>
    (
      await db.query(
        "select version, name, statements from supabase_migrations.schema_migrations order by version"
      )
    ).rows;

  beforeAll(async () => {
    admin = new Client({ connectionString: ADMIN_URL });
    await admin.connect();
  });
  afterAll(async () => {
    await db?.end().catch(() => {});
    for (const n of created) await admin.query(`drop database if exists ${n} with (force)`);
    await admin.end();
  });
  beforeEach(async () => {
    await db?.end().catch(() => {});
    name = `adopt_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    await admin.query(`create database ${name}`);
    created.push(name);
    db = new Client({ connectionString: dbUrl(name) });
    await db.connect();
  });

  it("records the plan in the school's own table, runs none of the SQL, and is safe to repeat", async () => {
    const plan = planAdoption(reg(V1, V2, V3), [], V2);
    expect(await adoptSchool(db, plan)).toEqual([V1, V2]);
    const rows = await table();
    expect(rows.map((r) => r.version)).toEqual([V1, V2]);
    expect(rows[0]).toMatchObject({ name: `${V1}_m`, statements: [] });
    // nothing was executed: no tables appeared
    expect(
      (
        await db.query(
          "select count(*)::int as n from information_schema.tables where table_schema = 'public'"
        )
      ).rows[0].n
    ).toBe(0);
    // a second run records nothing new
    expect(await adoptSchool(db, plan)).toEqual([]);
    expect((await table()).length).toBe(2);
  });

  it("reads the table again under the lock, so a stale plan cannot double-record", async () => {
    const stale = planAdoption(reg(V1, V2), [], V2);
    await db.query("create schema supabase_migrations");
    await db.query(
      "create table supabase_migrations.schema_migrations (version text not null primary key, statements text[], name text)"
    );
    await db.query(
      "insert into supabase_migrations.schema_migrations (version, name, statements) values ($1, 'x', '{}')",
      [V1]
    );
    expect(await adoptSchool(db, stale)).toEqual([V2]);
    expect((await table()).map((r) => r.version)).toEqual([V1, V2]);
  });

  it("will not run while a migration run holds the lock, and leaves nothing behind", async () => {
    const other = new Client({ connectionString: dbUrl(name) });
    await other.connect();
    try {
      await other.query("select pg_advisory_lock($1)", [LOCK_KEY]);
      await expect(adoptSchool(db, planAdoption(reg(V1), [], V1))).rejects.toThrow(
        /migration run is in progress/
      );
      expect(await readAppliedVersionsReadOnly(db)).toEqual([]);
    } finally {
      await other.end();
    }
  });

  it("refuses a plan that has errors, writing nothing", async () => {
    await expect(adoptSchool(db, planAdoption(reg(V1), [], "20260150000000"))).rejects.toThrow(
      /not a registered/
    );
    expect(await readAppliedVersionsReadOnly(db)).toEqual([]);
  });

  it("is the point of it all: after adoption the runner applies only the newer migrations", async () => {
    // The school already has its schema from before the runner existed.
    await db.query(
      "create table students (id int primary key); alter table students add column name text;"
    );
    const mig = (version: string, sql: string): RunnerMigration => ({
      id: `id-${version}`,
      version,
      name: `${version}_m`,
      sql,
      checksum: checksumOf(sql),
      kind: "expand",
      minAppVersion: null,
      releaseSeq: 1,
    });
    const migrations = [
      mig(V1, "create table students (id int primary key);"),
      mig(V2, "alter table students add column name text;"),
      mig(V3, "alter table students add column grade int;"),
    ];
    const runner = (registered: RunnerMigration[]) => ({
      db,
      registered,
      targetSeq: 1,
      currentTag: null,
      appSeq: () => null,
      recorder: { start: async () => "r", finish: async () => {} },
    });

    // Without adoption the runner tries to create what is already there and stops.
    await expect(applyPendingMigrations(runner(migrations))).rejects.toThrow(/already exists/);

    // Adopt through V2, and it applies V3 and nothing else.
    await db.query("drop schema supabase_migrations cascade");
    await adoptSchool(db, planAdoption(migrations, [], V2));
    const result = await applyPendingMigrations(runner(migrations));
    expect(result.applied).toEqual([`${V3}_m`]);
    expect(
      (
        await db.query(
          "select column_name from information_schema.columns where table_name = 'students' order by 1"
        )
      ).rows.map((r) => r.column_name)
    ).toEqual(["grade", "id", "name"]);
  });
});
