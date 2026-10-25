import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "pg";
import { checksumOf } from "@/lib/migrate/parse";
import type { DeployCommand, DeployOutcome } from "@/lib/deploy/client";
import type { ProbeResult } from "@/lib/health";
import { EnvSecrets } from "@/worker/secrets";
import { SupabaseStore } from "@/worker/store";
import { tick, type WorkerDeps } from "@/worker/run";
import { pgSupabase } from "@/tests/helpers/pg-supabase";
import { fakeBackup } from "@/tests/helpers/fake-backup";

// End to end: the real worker store, the real SQL state machine, the real
// migration runner and real school databases, all on throwaway Postgres
// databases. Only the deploy (SSH) and the health probe (HTTP) are faked.
// Set RUNNER_TEST_PG to a superuser connection string to run these.
const ADMIN_URL = process.env.RUNNER_TEST_PG;

const TAG_A = "a".repeat(40);
const TAG_B = "b".repeat(40);
const TAG_C = "c".repeat(40);
const M1 = { version: "20261001000000", sql: "create table students (id int);" };
const M2 = { version: "20261002000000", sql: "alter table students add column name text;" };

const dbUrl = (name: string) => ADMIN_URL!.replace(/\/[^/]*$/, `/${name}`);
const mig = (m: { version: string; sql: string }, extra: Record<string, unknown> = {}) => ({
  version: m.version,
  name: `${m.version}_m`,
  checksum: checksumOf(m.sql),
  kind: "expand",
  sql: m.sql,
  ...extra,
});

describe.skipIf(!ADMIN_URL)("rollout end to end (real store, SQL and databases)", () => {
  let admin: Client;
  let cp: Client; // control plane
  let schools: Record<string, Client> = {};
  const created: string[] = [];
  let store: SupabaseStore;
  let rpc: ReturnType<typeof pgSupabase>["rpc"];
  let deployImpl: (cmd: DeployCommand) => Promise<DeployOutcome>;
  let deploys: DeployCommand[];
  let deps: WorkerDeps;
  let backup: ReturnType<typeof fakeBackup>;

  const ok: DeployOutcome = { ok: true, code: 0, status: "ok", tag: "", message: "" };
  const q = async (c: Client, sql: string, params: unknown[] = []) =>
    (await c.query(sql, params)).rows;
  const one = async (sql: string, params: unknown[] = []) => (await q(cp, sql, params))[0];
  const newDb = async (prefix: string) => {
    const name = `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    await admin.query(`create database ${name}`);
    created.push(name);
    const c = new Client({ connectionString: dbUrl(name) });
    await c.connect();
    return c;
  };
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = await rpc(name, args);
    if (res.error) throw new Error(res.error.message);
    return res.data;
  };
  const register = (tag: string, migrations: unknown[]) =>
    call("register_release", {
      p_tag: tag,
      p_notes: null,
      p_by: "t",
      p_migrations: JSON.stringify(migrations),
    });
  const release = async (tag: string) =>
    (await one("select id from releases where image_tag = $1", [tag])).id as string;
  const startRollout = async (tag: string, batch = 1) =>
    call("create_rollout", {
      p_release: await release(tag),
      p_batch_size: batch,
      p_by: "t",
    }) as Promise<string>;
  const schoolRow = (slug: string) => one("select * from schools where slug = $1", [slug]);
  const stepFor = async (slug: string) =>
    one(
      "select st.* from rollout_steps st join schools s on s.id = st.school_id where s.slug = $1 order by st.position desc limit 1",
      [slug]
    );
  const columns = async (c: Client) =>
    (
      await q(
        c,
        "select column_name from information_schema.columns where table_name = 'students' order by 1"
      )
    ).map((r) => r.column_name);

  beforeAll(async () => {
    admin = new Client({ connectionString: ADMIN_URL });
    await admin.connect();
  });
  // Every test makes its own databases (tens of them by the end), so dropping
  // them one by one outgrew the default 10 s hook limit.
  afterAll(async () => {
    await cp?.end().catch(() => {});
    for (const c of Object.values(schools)) await c.end().catch(() => {});
    await Promise.all(
      created.map((name) => admin.query(`drop database if exists ${name} with (force)`))
    );
    await admin.end();
  }, 120_000);

  beforeEach(async () => {
    await cp?.end().catch(() => {});
    for (const c of Object.values(schools)) await c.end().catch(() => {});

    cp = await newDb("cp_e2e");
    await cp.query(readFileSync("tests/sql/prelude.sql", "utf8"));
    for (const f of readdirSync("supabase/migrations").sort())
      await cp.query(readFileSync(join("supabase/migrations", f), "utf8"));

    schools = { alpha: await newDb("school_alpha"), beta: await newDb("school_beta") };
    await cp.query(
      `insert into schools (slug, name, status, hostnames, supabase_project_ref, rollout_group, image_tag) values
         ('alpha', 'Alpha', 'active', '{alpha.example.com}', 'refalpha', 'test', $1),
         ('beta',  'Beta',  'active', '{beta.example.com}',  'refbeta',  'standard', $1)`,
      [TAG_A]
    );

    const client = pgSupabase(cp);
    rpc = client.rpc.bind(client) as typeof rpc;
    store = new SupabaseStore("http://unused", "unused", client);

    deploys = [];
    backup = fakeBackup();
    deployImpl = async (cmd) => ({ ...ok, tag: "tag" in cmd ? cmd.tag : "" });
    const urls = {
      alpha: "postgres://u:pw-alpha-123@alpha.db/x",
      beta: "postgres://u:pw-beta-1234@beta.db/x",
    };
    const byUrl = new Map(Object.entries(urls).map(([slug, url]) => [url, schools[slug]]));
    deps = {
      workerId: "w-test",
      store,
      secrets: new EnvSecrets(JSON.stringify(urls)),
      connect: async (url) => ({ db: byUrl.get(url)!, close: async () => {} }),
      deploy: async (cmd) => {
        deploys.push(cmd);
        return deployImpl(cmd);
      },
      probe: async (_host, slug): Promise<ProbeResult> => {
        const row = await schoolRow(slug);
        // the school reports whatever the (fake) deploy last put there
        const last = [...deploys]
          .reverse()
          .find((d) => d.action === "deploy" && d.slug === slug) as { tag: string } | undefined;
        return {
          ok: true,
          httpStatus: 200,
          latencyMs: 5,
          version: last?.tag ?? row.image_tag,
          error: null,
        };
      },
      backup,
      backupKeep: 3,
      log: () => {},
      heartbeatMs: 60_000,
    };
  });

  it("walks a release across schools in canary order, end to end", async () => {
    await register(TAG_A, [mig(M1)]);
    await register(TAG_B, [mig(M2)]);
    const rollout = await startRollout(TAG_B, 1);

    // nothing runs until the owner releases it
    expect(await tick(deps)).toBe(false);

    await call("release_rollout", { p_rollout: rollout, p_target: "test" });
    expect(await tick(deps)).toBe(true);

    const alpha = await schoolRow("alpha");
    expect(alpha.image_tag).toBe(TAG_B);
    expect(alpha.schema_version).toBe(M2.version);
    expect(alpha.credentials_status).toBe("ok");
    expect(await columns(schools.alpha)).toEqual(["id", "name"]);
    expect(await columns(schools.beta)).toEqual([]); // not released yet: untouched
    expect(deploys).toEqual([{ action: "deploy", slug: "alpha", tag: TAG_B }]);

    const runs = await q(
      cp,
      "select m.version, r.status, r.step_id from migration_runs r join migrations m on m.id = r.migration_id order by m.version"
    );
    expect(runs.map((r) => [r.version, r.status])).toEqual([
      [M1.version, "succeeded"],
      [M2.version, "succeeded"],
    ]);
    expect((await stepFor("alpha")).status).toBe("succeeded");
    expect((await stepFor("alpha")).result).toMatchObject({
      applied: [`${M1.version}_m`, `${M2.version}_m`],
      from_tag: TAG_A,
      to_tag: TAG_B,
      deployed: true,
    });
    expect((await one("select status from rollouts")).status).toBe("running");
    expect(await tick(deps)).toBe(false); // waiting for the next release

    await call("release_rollout", { p_rollout: rollout, p_target: "next_batch" });
    expect(await tick(deps)).toBe(true);
    expect((await schoolRow("beta")).image_tag).toBe(TAG_B);
    expect(await columns(schools.beta)).toEqual(["id", "name"]);
    expect((await one("select status from rollouts")).status).toBe("succeeded");
    expect(deploys.map((d) => (d as { slug: string }).slug)).toEqual(["alpha", "beta"]);
    expect(
      (
        await one(
          "select count(*)::int as n from jobs where status = 'running' or status = 'queued'"
        )
      ).n
    ).toBe(0);
  });

  it("halts on a failed deploy, keeps the migrations, and resumes after a retry", async () => {
    await register(TAG_B, [mig(M1), mig(M2)]);
    const rollout = await startRollout(TAG_B);
    deployImpl = async () => ({
      ok: false,
      code: 10,
      status: "rolled_back",
      tag: TAG_A,
      message: "The new version was not healthy; the server rolled back to the old one.",
    });
    await call("release_rollout", { p_rollout: rollout, p_target: "test" });
    await tick(deps);

    const failed = await stepFor("alpha");
    expect(failed.status).toBe("failed");
    expect(failed.error).toMatch(/Deploy failed: .*rolled back/);
    expect((await one("select status, halt_reason from rollouts")).status).toBe("halted");
    expect((await schoolRow("alpha")).image_tag).toBe(TAG_A); // unchanged
    expect(await columns(schools.alpha)).toEqual(["id", "name"]); // migrations stay applied
    expect(await tick(deps)).toBe(false); // nothing else runs while halted
    await expect(
      call("release_rollout", { p_rollout: rollout, p_target: "next_batch" })
    ).rejects.toThrow(/halted/);

    deployImpl = async (cmd) => ({ ...ok, tag: "tag" in cmd ? cmd.tag : "" });
    await call("retry_step", { p_step: failed.id });
    await tick(deps);
    const retried = await stepFor("alpha");
    expect(retried).toMatchObject({ status: "succeeded", attempt: 2 });
    expect(retried.result).toMatchObject({ applied: [], deployed: true }); // nothing left to migrate
    expect((await schoolRow("alpha")).image_tag).toBe(TAG_B);
    expect((await one("select status from rollouts")).status).toBe("running");
  });

  it("stops at a failing migration: it is rolled back, later schools are untouched", async () => {
    await register(TAG_B, [
      mig(M1),
      mig({ version: M2.version, sql: "alter table students add column x text; select 1/0;" }),
    ]);
    const rollout = await startRollout(TAG_B);
    await call("release_rollout", { p_rollout: rollout, p_target: "test" });
    await tick(deps);

    const step = await stepFor("alpha");
    expect(step.status).toBe("failed");
    expect(step.error).toMatch(/division by zero/);
    expect(step.result).toMatchObject({ applied: [`${M1.version}_m`] });
    expect(await columns(schools.alpha)).toEqual(["id"]); // M2 rolled back completely
    expect(deploys).toEqual([]); // never deployed
    expect((await schoolRow("alpha")).schema_version).toBe(M1.version);
    const runs = await q(
      cp,
      "select m.version, r.status from migration_runs r join migrations m on m.id = r.migration_id order by m.version"
    );
    expect(runs.map((r) => [r.version, r.status])).toEqual([
      [M1.version, "succeeded"],
      [M2.version, "failed"],
    ]);
    expect(await columns(schools.beta)).toEqual([]);
    expect((await one("select status from rollouts")).status).toBe("halted");
  });

  it("refuses a contract migration for a school on an older app, applying nothing", async () => {
    await register(TAG_A, [mig(M1)]);
    await register(TAG_B, [mig(M2, { kind: "contract", min_app_version: TAG_B })]);
    const rollout = await startRollout(TAG_B);
    await call("release_rollout", { p_rollout: rollout, p_target: "test" });
    await tick(deps);
    const step = await stepFor("alpha");
    expect(step.status).toBe("failed");
    expect(step.error).toMatch(/contract migration that needs app version/);
    expect(await columns(schools.alpha)).toEqual([]);
    expect(deploys).toEqual([]);
  });

  it("does not run a step that was cancelled before the worker got to it", async () => {
    await register(TAG_B, [mig(M1)]);
    const rollout = await startRollout(TAG_B);
    await call("release_rollout", { p_rollout: rollout, p_target: "test" });
    await call("cancel_rollout", { p_rollout: rollout });
    expect(await tick(deps)).toBe(false);
    expect(await columns(schools.alpha)).toEqual([]);
    expect(deploys).toEqual([]);
    expect((await stepFor("alpha")).status).toBe("cancelled");
  });

  it("recovers a job whose worker died, and finishes it exactly once", async () => {
    await register(TAG_B, [mig(M1)]);
    const rollout = await startRollout(TAG_B);
    await call("release_rollout", { p_rollout: rollout, p_target: "test" });

    // a worker claims the job and starts the step, then dies
    const claimed = await store.claimJob("dead-worker", ["rollout_step"]);
    expect(claimed).not.toBeNull();
    await store.startStep(claimed!.payload.step_id as string);
    await cp.query("update jobs set locked_at = now() - interval '2 hours' where id = $1", [
      claimed!.id,
    ]);
    expect(await store.requeueStale(45)).toBe(1);

    expect(await tick(deps)).toBe(true);
    expect((await stepFor("alpha")).status).toBe("succeeded");
    const job = await one("select status, attempts from jobs where id = $1", [claimed!.id]);
    expect(job).toMatchObject({ status: "succeeded", attempts: 2 });
    expect(deploys).toHaveLength(1);
  });

  it("retries a job after an infrastructure error, with a delay", async () => {
    await register(TAG_B, [mig(M1)]);
    const rollout = await startRollout(TAG_B);
    await call("release_rollout", { p_rollout: rollout, p_target: "test" });

    const realLoad = store.loadStep.bind(store);
    let failures = 1;
    store.loadStep = async (id) => {
      if (failures-- > 0) throw new Error("control plane hiccup");
      return realLoad(id);
    };
    expect(await tick(deps)).toBe(true);
    const queued = await one("select status, run_after > now() as delayed, error from jobs");
    expect(queued).toMatchObject({ status: "queued", delayed: true });
    expect(queued.error).toMatch(/hiccup/);
    expect(await tick(deps)).toBe(false); // not due yet

    await cp.query("update jobs set run_after = now()");
    expect(await tick(deps)).toBe(true);
    expect((await stepFor("alpha")).status).toBe("succeeded");
  });

  it("reads each school's applied migrations when asked to scan", async () => {
    await register(TAG_A, [mig(M1), mig(M2)]);
    await schools.alpha.query("create schema supabase_migrations");
    await schools.alpha.query(
      "create table supabase_migrations.schema_migrations (version text primary key, statements text[], name text)"
    );
    await schools.alpha.query(
      "insert into supabase_migrations.schema_migrations (version) values ($1), ($2)",
      [M1.version, M2.version]
    );

    expect(await call("enqueue_schema_scan", { p_school: null })).toBe(2);
    expect(await call("enqueue_schema_scan", { p_school: null })).toBe(0); // already waiting
    expect(await tick(deps)).toBe(true);
    expect(await tick(deps)).toBe(true);
    expect(await tick(deps)).toBe(false);

    expect((await schoolRow("alpha")).schema_version).toBe(M2.version);
    expect((await schoolRow("beta")).schema_version).toBeNull();
    expect((await schoolRow("alpha")).credentials_status).toBe("ok");
    const beta = await q(
      schools.beta,
      "select to_regclass('supabase_migrations.schema_migrations') as t"
    );
    expect(beta[0].t).toBeNull(); // looking created nothing
  });

  it("reconciles a run left 'running' by a dead worker from the school's own table", async () => {
    await register(TAG_B, [mig(M1), mig(M2)]);
    const migrations = await q(cp, "select id, version from migrations order by version");
    const alphaId = (await schoolRow("alpha")).id;
    // M1 actually landed in the school; M2 did not. Both runs were left "running".
    await schools.alpha.query("create schema supabase_migrations");
    await schools.alpha.query(
      "create table supabase_migrations.schema_migrations (version text primary key, statements text[], name text)"
    );
    await schools.alpha.query(M1.sql);
    await schools.alpha.query(
      "insert into supabase_migrations.schema_migrations (version, name) values ($1, 'm')",
      [M1.version]
    );
    for (const m of migrations)
      await cp.query(
        "insert into migration_runs (school_id, migration_id, status) values ($1, $2, 'running')",
        [alphaId, m.id]
      );

    const rollout = await startRollout(TAG_B);
    await call("release_rollout", { p_rollout: rollout, p_target: "test" });
    await tick(deps);

    const runs = await q(
      cp,
      "select m.version, r.status from migration_runs r join migrations m on m.id = r.migration_id order by m.version, r.started_at"
    );
    // M1: the stale run is marked succeeded (it landed). M2: the stale run is failed, then a new run succeeded.
    expect(runs.filter((r) => r.version === M1.version).map((r) => r.status)).toEqual([
      "succeeded",
    ]);
    expect(
      runs
        .filter((r) => r.version === M2.version)
        .map((r) => r.status)
        .sort()
    ).toEqual(["failed", "succeeded"]);
    expect(await q(cp, "select 1 from migration_runs where status = 'running'")).toEqual([]);
    expect(await columns(schools.alpha)).toEqual(["id", "name"]);
  });

  describe("backups", () => {
    const startRolloutWith = async (tag: string, policy: string) =>
      call("create_rollout", {
        p_release: await release(tag),
        p_batch_size: 1,
        p_by: "t",
        p_backup_policy: policy,
      }) as Promise<string>;
    const backupRows = () => q(cp, "select * from backups order by started_at, id");

    it("backs up a school before migrating it, and records the backup against that step", async () => {
      await register(TAG_B, [mig(M1), mig(M2)]);
      const seen: string[][] = [];
      backup.create = vi.fn(async (req) => {
        seen.push(await columns(schools[req.slug]));
        return {
          objectKey: `schools/${req.slug}/k.dump.age`,
          sizeBytes: 9000,
          sha256: "c".repeat(64),
        };
      });
      const rollout = await startRollout(TAG_B);
      await call("release_rollout", { p_rollout: rollout, p_target: "test" });
      await tick(deps);

      expect(seen).toEqual([[]]); // alpha had no table yet when it was backed up
      expect(await columns(schools.alpha)).toEqual(["id", "name"]);
      const step = await stepFor("alpha");
      const rows = await backupRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        status: "succeeded",
        step_id: step.id,
        object_key: "schools/alpha/k.dump.age",
        pruned_at: null,
      });
      expect(Number(rows[0].size_bytes)).toBe(9000);
      expect(rows[0].school_id).toBe((await schoolRow("alpha")).id);
      expect(step.result.backup).toMatchObject({ status: "taken", id: rows[0].id });
    });

    it("halts the rollout and touches nothing when the backup fails, then goes on after a retry", async () => {
      await register(TAG_B, [mig(M1)]);
      let fail = true;
      const good = backup.create;
      backup.create = vi.fn(async (req) => {
        if (fail) throw new Error("R2 said no");
        return good(req);
      });
      const rollout = await startRollout(TAG_B);
      await call("release_rollout", { p_rollout: rollout, p_target: "test" });
      await tick(deps);

      const failed = await stepFor("alpha");
      expect(failed.status).toBe("failed");
      expect(failed.error).toMatch(/The backup failed, so no migration was run: R2 said no/);
      expect((await one("select status from rollouts")).status).toBe("halted");
      expect(await columns(schools.alpha)).toEqual([]); // not migrated
      expect(deploys).toEqual([]); // not deployed
      expect((await schoolRow("alpha")).image_tag).toBe(TAG_A);
      expect((await q(cp, "select count(*)::int as n from migration_runs"))[0].n).toBe(0);
      expect((await backupRows()).map((r) => r.status)).toEqual(["failed"]);
      expect((await backupRows())[0].error).toMatch(/R2 said no/);
      expect(await tick(deps)).toBe(false);

      fail = false;
      await call("retry_step", { p_step: failed.id });
      await tick(deps);
      expect((await stepFor("alpha")).status).toBe("succeeded");
      expect(await columns(schools.alpha)).toEqual(["id"]);
      expect((await backupRows()).map((r) => r.status)).toEqual(["failed", "succeeded"]);
    });

    it("skips the backup when the rollout allows it and only expand migrations are pending", async () => {
      await register(TAG_B, [mig(M1)]);
      const rollout = await startRolloutWith(TAG_B, "skip_if_expand_only");
      await call("release_rollout", { p_rollout: rollout, p_target: "test" });
      await tick(deps);
      expect((await stepFor("alpha")).status).toBe("succeeded");
      expect(await columns(schools.alpha)).toEqual(["id"]);
      expect(await backupRows()).toEqual([]);
      expect(backup.created).toEqual([]);
      expect((await stepFor("alpha")).result.backup).toMatchObject({ status: "skipped" });
    });

    it("still backs up before a contract migration when skipping is allowed", async () => {
      await register(TAG_A, [mig(M1)]);
      await register(TAG_B, [mig(M2, { kind: "contract", min_app_version: TAG_A })]);
      const rollout = await startRolloutWith(TAG_B, "skip_if_expand_only");
      await call("release_rollout", { p_rollout: rollout, p_target: "test" });
      await tick(deps);
      expect((await stepFor("alpha")).status).toBe("succeeded");
      expect(backup.created.map((r) => r.slug)).toEqual(["alpha"]);
      expect((await backupRows()).map((r) => r.status)).toEqual(["succeeded"]);
    });

    it("takes no backup when the school has nothing to migrate", async () => {
      await register(TAG_B, []);
      const rollout = await startRollout(TAG_B);
      await call("release_rollout", { p_rollout: rollout, p_target: "test" });
      await tick(deps);
      expect((await stepFor("alpha")).status).toBe("succeeded");
      expect(await backupRows()).toEqual([]);
    });

    it("prunes old backups, keeping the newest few, and records which objects it deleted", async () => {
      await register(TAG_B, [mig(M1)]);
      const alphaId = (await schoolRow("alpha")).id;
      for (let day = 1; day <= 4; day++) {
        await cp.query(
          `insert into backups (school_id, status, object_key, size_bytes, sha256, started_at, finished_at)
           values ($1, 'succeeded', $2, 100, $3, $4, $4)`,
          [
            alphaId,
            `schools/alpha/old-${day}.dump.age`,
            "d".repeat(64),
            `2026-10-0${day}T00:00:00Z`,
          ]
        );
      }
      const rollout = await startRollout(TAG_B);
      await call("release_rollout", { p_rollout: rollout, p_target: "test" });
      await tick(deps);

      // 4 old + 1 new = 5 succeeded; backupKeep is 3, so the two oldest go
      expect(backup.removed.sort()).toEqual([
        "schools/alpha/old-1.dump.age",
        "schools/alpha/old-2.dump.age",
      ]);
      const rows = await q(cp, "select object_key, pruned_at from backups order by started_at, id");
      const pruned = rows.filter((r) => r.pruned_at).map((r) => r.object_key);
      expect(pruned.sort()).toEqual([
        "schools/alpha/old-1.dump.age",
        "schools/alpha/old-2.dump.age",
      ]);
      expect(rows).toHaveLength(5); // the records stay
      expect((await stepFor("alpha")).status).toBe("succeeded");
    });

    it("does not prune the backups of a rollout that is halted, where a restore is most likely", async () => {
      await register(TAG_B, [mig(M1)]);
      const alphaId = (await schoolRow("alpha")).id;
      const rollout = await startRollout(TAG_B);
      await call("release_rollout", { p_rollout: rollout, p_target: "test" });
      await tick(deps); // alpha succeeded, with its backup
      const mine = (await backupRows())[0];
      for (let day = 1; day <= 4; day++) {
        await cp.query(
          `insert into backups (school_id, status, object_key, size_bytes, sha256, started_at, finished_at)
           values ($1, 'succeeded', $2, 100, $3, $4, $4)`,
          [
            alphaId,
            `schools/alpha/newer-${day}.dump.age`,
            "d".repeat(64),
            `2027-01-0${day}T00:00:00Z`,
          ]
        );
      }
      // the rollout's own backup is now the oldest, but its rollout is still running
      const due = await q(cp, "select object_key from backups_to_prune($1, 3)", [alphaId]);
      expect(due.map((r) => r.object_key)).not.toContain(mine.object_key);
      await call("cancel_rollout", { p_rollout: rollout });
      const after = await q(cp, "select object_key from backups_to_prune($1, 3)", [alphaId]);
      expect(after.map((r) => r.object_key)).toContain(mine.object_key);
    });
  });

  // ------------------------------------------------------------------------
  // One school, rolling a school back, registering a release from the dashboard
  // ------------------------------------------------------------------------
  describe("one school, rollback and dashboard registration", () => {
    const TAG_D = "d".repeat(40);
    const M3 = { version: "20261003000000", sql: "alter table students add column grade int;" };
    const schoolId = async (slug: string) => (await schoolRow(slug)).id as string;
    const jobs = (type: string) =>
      q(
        cp,
        "select status, attempts, result, error from jobs where type = $1 order by created_at",
        [type]
      );

    // A fake server that remembers the current and previous tag of each school, the
    // way deploy/school-deploy does: deploy shifts current to previous, rollback swaps.
    function fakeServer(initial: Record<string, string>) {
      const server = new Map(
        Object.entries(initial).map(([slug, tag]) => [slug, { current: tag, previous: "" }])
      );
      const seen: string[] = [];
      deployImpl = async (cmd) => {
        seen.push(cmd.action);
        const s = server.get(cmd.slug)!;
        if (cmd.action === "status") return { ...ok, status: "running", tag: s.current };
        if (cmd.action === "deploy") {
          s.previous = s.current;
          s.current = cmd.tag;
          return { ...ok, tag: cmd.tag };
        }
        if (!s.previous)
          return {
            ...ok,
            ok: false,
            code: 3,
            status: "no_previous",
            message: "no previous version",
          };
        [s.current, s.previous] = [s.previous, s.current];
        return { ...ok, tag: s.current };
      };
      deps.probe = async (_h, slug): Promise<ProbeResult> => ({
        ok: true,
        httpStatus: 200,
        latencyMs: 5,
        version: server.get(slug)!.current,
        error: null,
      });
      return { server, seen };
    }

    it("rolls out to one school only, without canary stages", async () => {
      await register(TAG_A, [mig(M1)]);
      await register(TAG_B, [mig(M2)]);
      fakeServer({ alpha: TAG_A, beta: TAG_A });
      const rollout = (await call("create_school_rollout", {
        p_release: await release(TAG_B),
        p_school: await schoolId("beta"),
        p_by: "owner@example.com",
      })) as string;

      expect(
        await one("select scope, status, released_through from rollouts where id = $1", [rollout])
      ).toMatchObject({
        scope: "school",
        status: "running",
        released_through: 1,
      });
      expect(await tick(deps)).toBe(true); // queued at once: nobody releases a stage
      expect(await tick(deps)).toBe(false);

      expect((await schoolRow("beta")).image_tag).toBe(TAG_B);
      expect(await columns(schools.beta)).toEqual(["id", "name"]);
      expect((await schoolRow("alpha")).image_tag).toBe(TAG_A); // untouched
      expect(await columns(schools.alpha)).toEqual([]);
      expect((await one("select status from rollouts where id = $1", [rollout])).status).toBe(
        "succeeded"
      );
      expect((await stepFor("beta")).stage).toBe("single");
    });

    it("backs a school up before a one-school rollout migrates it, as a full rollout does", async () => {
      await register(TAG_A, [mig(M1)]);
      await register(TAG_B, [mig(M2)]);
      fakeServer({ alpha: TAG_A, beta: TAG_A });
      const seen: string[][] = [];
      backup.create = vi.fn(async (req) => {
        seen.push(await columns(schools[req.slug]));
        return {
          objectKey: `schools/${req.slug}/single.dump.age`,
          sizeBytes: 7000,
          sha256: "e".repeat(64),
        };
      });
      await call("create_school_rollout", {
        p_release: await release(TAG_B),
        p_school: await schoolId("beta"),
        p_by: "owner@example.com",
      });
      await tick(deps);

      expect(backup.create).toHaveBeenCalledTimes(1);
      expect(seen).toEqual([[]]); // beta was still unmigrated when it was backed up
      expect(await columns(schools.beta)).toEqual(["id", "name"]);
      const rows = await q(cp, "select status, step_id, object_key from backups");
      expect(rows).toEqual([
        {
          status: "succeeded",
          step_id: (await stepFor("beta")).id,
          object_key: "schools/beta/single.dump.age",
        },
      ]);
    });

    it("halts a one-school rollout on a failed deploy, and a retry finishes it", async () => {
      await register(TAG_A, [mig(M1)]);
      await register(TAG_B, [mig(M2)]);
      fakeServer({ alpha: TAG_A, beta: TAG_A });
      const good = deployImpl;
      deployImpl = async (cmd) =>
        cmd.action === "deploy"
          ? { ...ok, ok: false, code: 10, status: "rolled_back", message: "unhealthy" }
          : good(cmd);
      const rollout = (await call("create_school_rollout", {
        p_release: await release(TAG_B),
        p_school: await schoolId("beta"),
        p_by: "o",
      })) as string;
      await tick(deps);
      expect((await one("select status from rollouts where id = $1", [rollout])).status).toBe(
        "halted"
      );
      expect(await columns(schools.beta)).toEqual(["id", "name"]); // the migrations stay

      deployImpl = good;
      await call("retry_step", { p_step: (await stepFor("beta")).id });
      await tick(deps);
      expect((await one("select status from rollouts where id = $1", [rollout])).status).toBe(
        "succeeded"
      );
      expect((await schoolRow("beta")).image_tag).toBe(TAG_B);
    });

    it("refuses a rollout of an older release over a school on a newer one", async () => {
      await register(TAG_A, [mig(M1)]);
      await register(TAG_B, [mig(M2)]);
      await cp.query("update schools set image_tag = $1 where slug = 'beta'", [TAG_B]);
      await expect(
        call("create_school_rollout", {
          p_release: await release(TAG_A),
          p_school: await schoolId("beta"),
          p_by: "o",
        })
      ).rejects.toThrow(/newer release than this one/);
      await expect(startRollout(TAG_A)).rejects.toThrow(/newer release than this one: beta/);
    });

    it("rolls a school back through the worker, migrations stay, and records the version it is on", async () => {
      await register(TAG_A, [mig(M1)]);
      await register(TAG_B, [mig(M2)]);
      const { seen } = fakeServer({ alpha: TAG_A, beta: TAG_A });
      await call("create_school_rollout", {
        p_release: await release(TAG_B),
        p_school: await schoolId("beta"),
        p_by: "o",
      });
      await tick(deps);
      expect((await schoolRow("beta")).image_tag).toBe(TAG_B);
      seen.length = 0;

      await call("queue_school_rollback", {
        p_school: await schoolId("beta"),
        p_by: "owner@example.com",
      });
      expect(await tick(deps)).toBe(true);

      expect(seen).toEqual(["status", "rollback"]); // checks first, then acts
      expect((await schoolRow("beta")).image_tag).toBe(TAG_A);
      expect((await schoolRow("beta")).app_version).toBe(TAG_A);
      expect(await columns(schools.beta)).toEqual(["id", "name"]); // migrations are not undone
      const [job] = await jobs("school_rollback");
      expect(job).toMatchObject({ status: "succeeded", attempts: 1 });
      expect(job.result).toMatchObject({ from_tag: TAG_B, to_tag: TAG_A });
    });

    it("does not roll back when the server disagrees about what is running", async () => {
      await register(TAG_A, [mig(M1)]);
      await register(TAG_B, [mig(M2)]);
      const { server, seen } = fakeServer({ alpha: TAG_A, beta: TAG_A });
      await call("create_school_rollout", {
        p_release: await release(TAG_B),
        p_school: await schoolId("beta"),
        p_by: "o",
      });
      await tick(deps);
      server.get("beta")!.current = TAG_A; // someone changed the server by hand
      seen.length = 0;

      await call("queue_school_rollback", { p_school: await schoolId("beta"), p_by: "o" });
      await tick(deps);

      expect(seen).toEqual(["status"]); // never sent the rollback: it could have flipped forward
      const [job] = await jobs("school_rollback");
      expect(job.status).toBe("failed");
      expect(job.error).toMatch(/server says .* is running but the dashboard says/);
      expect((await schoolRow("beta")).image_tag).toBe(TAG_B);
    });

    it("never repeats a rollback: an error is a failed job after one attempt", async () => {
      await register(TAG_A, [mig(M1)]);
      await register(TAG_B, [mig(M2)]);
      fakeServer({ alpha: TAG_A, beta: TAG_A });
      await call("create_school_rollout", {
        p_release: await release(TAG_B),
        p_school: await schoolId("beta"),
        p_by: "o",
      });
      await tick(deps);
      const good = deployImpl;
      deployImpl = async (cmd) => {
        if (cmd.action === "rollback") throw new Error("ssh connection reset");
        return good(cmd);
      };
      await call("queue_school_rollback", { p_school: await schoolId("beta"), p_by: "o" });
      await tick(deps);
      expect(await tick(deps)).toBe(false); // nothing is waiting to be retried
      const [job] = await jobs("school_rollback");
      expect(job).toMatchObject({ status: "failed", attempts: 1 });
      expect(job.error).toMatch(/ssh connection reset/);
    });

    it("registers a release from the dashboard's job: same rules as the CLI", async () => {
      await register(TAG_A, [mig(M1), mig(M2)]);
      deps.fetchMigrations = async (tag) => {
        expect(tag).toBe(TAG_D);
        return [
          { name: `${M1.version}_students.sql`, content: M1.sql },
          { name: `${M2.version}_name.sql`, content: M2.sql },
          { name: `${M3.version}_grade.sql`, content: M3.sql },
        ];
      };
      await call("queue_register_release", {
        p_tag: TAG_D,
        p_notes: "adds grade",
        p_by: "owner@example.com",
      });
      expect(await tick(deps)).toBe(true);

      const [job] = await jobs("register_release");
      expect(job.error).toBeNull();
      expect(job.status).toBe("succeeded");
      expect(job.result).toEqual({ migrations: [`${M3.version}_grade`] });
      const rel = await one(
        "select notes, registered_by, image_tag from releases where image_tag = $1",
        [TAG_D]
      );
      expect(rel).toMatchObject({ notes: "adds grade", registered_by: "owner@example.com" });
      expect(
        (await q(cp, "select version from migrations order by version")).map((r) => r.version)
      ).toEqual([M1.version, M2.version, M3.version]);
    });

    it("refuses to register an edited migration, and registers nothing", async () => {
      await register(TAG_A, [mig(M1)]);
      deps.fetchMigrations = async () => [
        { name: `${M1.version}_students.sql`, content: "create table students (id bigint);" },
      ];
      await call("queue_register_release", { p_tag: TAG_D, p_notes: null, p_by: "o" });
      await tick(deps);
      const [job] = await jobs("register_release");
      expect(job.status).toBe("failed");
      expect(job.error).toMatch(/was changed after it was registered/);
      expect(await q(cp, "select 1 from releases where image_tag = $1", [TAG_D])).toEqual([]);
    });

    it("explains when the worker has no GitHub token", async () => {
      await register(TAG_A, [mig(M1)]);
      deps.fetchMigrations = undefined;
      await call("queue_register_release", { p_tag: TAG_D, p_notes: null, p_by: "o" });
      await tick(deps);
      expect((await jobs("register_release"))[0].error).toMatch(/no GITHUB_TOKEN/);
    });
  });
});
