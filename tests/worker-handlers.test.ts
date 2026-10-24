import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "pg";
import { checksumOf } from "@/lib/migrate/parse";
import type { RunnerMigration } from "@/lib/migrate/runner";
import type { DeployOutcome } from "@/lib/deploy/client";
import type { ProbeResult } from "@/lib/health";
import { EnvSecrets } from "@/worker/secrets";
import {
  classifyConnectError,
  handleRolloutStep,
  handleSchemaScan,
  type HandlerDeps,
} from "@/worker/handlers";
import type { StepContext } from "@/worker/store";
import { fakeStore, job } from "@/tests/helpers/fake-store";

const ADMIN_URL = process.env.RUNNER_TEST_PG;
const TAG_OLD = "1".repeat(40);
const TAG_NEW = "2".repeat(40);
const DB_URL = "postgres://postgres:s3cretPassw0rd@db.example.supabase.co:5432/postgres";
const secrets = new EnvSecrets(JSON.stringify({ greenfield: DB_URL }));

const mig = (
  version: string,
  sql: string,
  extra: Partial<RunnerMigration> = {}
): RunnerMigration => ({
  id: `id-${version}`,
  version,
  name: `${version}_m`,
  sql,
  checksum: checksumOf(sql),
  kind: "expand",
  minAppVersion: null,
  releaseSeq: 2,
  ...extra,
});

const context = (over: Partial<StepContext["school"]> = {}): StepContext => ({
  step: { id: "step-1", rollout_id: "r1", school_id: "school-1", attempt: 1 },
  rollout: { id: "r1", image_tag: TAG_NEW, status: "running", release_seq: 2 },
  school: {
    id: "school-1",
    slug: "greenfield",
    status: "active",
    hostnames: ["green.example.com"],
    image_tag: TAG_OLD,
    ...over,
  },
});

const okDeploy: DeployOutcome = { ok: true, code: 0, status: "ok", tag: TAG_NEW, message: "" };
const okProbe: ProbeResult = {
  ok: true,
  httpStatus: 200,
  latencyMs: 20,
  version: TAG_NEW,
  error: null,
};

function deps(store: ReturnType<typeof fakeStore>, over: Partial<HandlerDeps> = {}) {
  const deploy = vi.fn(async (): Promise<DeployOutcome> => okDeploy);
  const probe = vi.fn(async (): Promise<ProbeResult> => okProbe);
  const connect = vi.fn(async () => {
    throw new Error("connect not expected in this test");
  });
  const d: HandlerDeps = { store, secrets, connect, deploy, probe, log: () => {}, ...over };
  return { d, deploy, probe, connect };
}

describe("rollout step: failures before any database work", () => {
  it("fails a job with no step id, without touching anything", async () => {
    const store = fakeStore();
    const { d } = deps(store);
    const out = await handleRolloutStep(job({ payload: {} }), d);
    expect(out.ok).toBe(false);
    expect(store.startStep).not.toHaveBeenCalled();
  });

  it("fails a job whose step does not exist", async () => {
    const store = fakeStore({ loadStep: vi.fn(async () => null) });
    const out = await handleRolloutStep(job(), deps(store).d);
    expect(out).toMatchObject({ ok: false, error: expect.stringMatching(/does not exist/) });
    expect(store.completeStep).not.toHaveBeenCalled();
  });

  it("does nothing, and reports nothing, when the step was cancelled before it started", async () => {
    const store = fakeStore({
      loadStep: vi.fn(async () => context()),
      startStep: vi.fn(async () => false),
    });
    const { d, deploy, connect } = deps(store);
    const out = await handleRolloutStep(job(), d);
    expect(out).toEqual({ ok: true, result: { skipped: true } });
    expect(connect).not.toHaveBeenCalled();
    expect(deploy).not.toHaveBeenCalled();
    expect(store.completeStep).not.toHaveBeenCalled();
  });

  it("lets an infrastructure error loading the step propagate, so the job is retried", async () => {
    const store = fakeStore({
      loadStep: vi.fn(async () => {
        throw new Error("control plane unreachable");
      }),
    });
    await expect(handleRolloutStep(job(), deps(store).d)).rejects.toThrow(/unreachable/);
    expect(store.completeStep).not.toHaveBeenCalled();
  });

  it("lets an infrastructure error starting the step propagate", async () => {
    const store = fakeStore({
      loadStep: vi.fn(async () => context()),
      startStep: vi.fn(async () => {
        throw new Error("control plane unreachable");
      }),
    });
    await expect(handleRolloutStep(job(), deps(store).d)).rejects.toThrow(/unreachable/);
  });

  it.each([
    ["a suspended school", { status: "suspended" }, /suspended, not active/],
    ["a school with no hostname", { hostnames: [] }, /no hostname/],
    ["a school with no database URL", { slug: "redfield" }, /No database URL for "redfield"/],
  ])(
    "fails %s through complete_step, before connecting or deploying",
    async (_n, patch, message) => {
      const store = fakeStore({ loadStep: vi.fn(async () => context(patch)) });
      const { d, deploy, connect } = deps(store);
      const out = await handleRolloutStep(job(), d);
      expect(out.ok).toBe(false);
      expect(out.error).toMatch(message);
      expect(store.completions).toHaveLength(1);
      expect(store.completions[0]).toMatchObject({ stepId: "step-1", ok: false });
      expect(connect).not.toHaveBeenCalled();
      expect(deploy).not.toHaveBeenCalled();
    }
  );

  it("redacts the database URL and password from a stored error", async () => {
    const store = fakeStore({ loadStep: vi.fn(async () => context()) });
    const connect = vi.fn(async () => {
      throw Object.assign(new Error(`connect failed for ${DB_URL} (password s3cretPassw0rd)`), {
        code: "ECONNREFUSED",
      });
    });
    const out = await handleRolloutStep(job(), deps(store, { connect }).d);
    expect(out.ok).toBe(false);
    expect(store.completions[0].error).not.toContain("s3cretPassw0rd");
    expect(store.completions[0].error).not.toContain("postgres://");
    expect(out.error).toContain("[database url]");
  });
});

describe.skipIf(!ADMIN_URL)("rollout step against a real database", () => {
  let admin: Client;
  let db: Client;
  let dbName: string;

  const connectTo = () => vi.fn(async () => ({ db, close: vi.fn(async () => {}) }));
  const tables = async () =>
    (
      await db.query(
        "select table_name from information_schema.tables where table_schema = 'public' order by 1"
      )
    ).rows.map((r) => String(r.table_name));
  const run = (store: ReturnType<typeof fakeStore>, over: Partial<HandlerDeps> = {}) => {
    const harness = deps(store, { connect: connectTo(), ...over });
    return { ...harness, result: handleRolloutStep(job(), harness.d) };
  };
  const seqs = new Map([
    [TAG_OLD, 1],
    [TAG_NEW, 2],
  ]);
  const storeWith = (migrations: RunnerMigration[], school: Partial<StepContext["school"]> = {}) =>
    fakeStore({
      loadStep: vi.fn(async () => context(school)),
      registeredMigrations: vi.fn(async () => migrations),
      releaseSeqs: vi.fn(async () => seqs),
    });

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
    dbName = `handler_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    await admin.query(`create database ${dbName}`);
    db = new Client({ connectionString: ADMIN_URL!.replace(/\/[^/]*$/, `/${dbName}`) });
    await db.connect();
  });

  it("migrates, deploys, verifies, and records the school's new state", async () => {
    const store = storeWith([
      mig("20261001000000", "create table a (id int);"),
      mig("20261002000000", "create table b (id int);"),
    ]);
    const { deploy, probe, result } = run(store);
    const out = await result;

    expect(out.ok).toBe(true);
    expect(await tables()).toEqual(["a", "b"]);
    expect(deploy).toHaveBeenCalledTimes(1);
    expect(deploy).toHaveBeenCalledWith({ action: "deploy", slug: "greenfield", tag: TAG_NEW });
    expect(probe).toHaveBeenCalledWith("green.example.com", "greenfield");
    expect(store.runs.map((r) => r.status)).toEqual(["succeeded", "succeeded"]);
    expect(store.patches).toContainEqual({
      schema_version: "20261002000000",
      credentials_status: "ok",
    });
    expect(store.patches).toContainEqual({ image_tag: TAG_NEW, app_version: TAG_NEW });
    expect(store.completions).toHaveLength(1);
    expect(store.completions[0]).toMatchObject({
      ok: true,
      error: null,
      result: {
        from_tag: TAG_OLD,
        to_tag: TAG_NEW,
        deployed: true,
        schema_version: "20261002000000",
      },
    });
    expect((store.completions[0].result as { applied: string[] }).applied).toHaveLength(2);
    // order matters: migrate, then deploy, then record the new tag, then report
    expect(store.calls).toEqual(["updateSchool", "updateSchool", "completeStep"]);
  });

  it("skips the deploy when the school already runs the target tag", async () => {
    const store = storeWith([mig("20261001000000", "create table a (id int);")], {
      image_tag: TAG_NEW,
    });
    const { deploy, result } = run(store);
    const out = await result;
    expect(out.ok).toBe(true);
    expect(deploy).not.toHaveBeenCalled();
    expect(store.completions[0].result).toMatchObject({ deployed: false });
  });

  it("stops when a migration fails: no deploy, no new tag, partial progress reported", async () => {
    const store = storeWith([
      mig("20261001000000", "create table ok_one (id int);"),
      mig("20261002000000", "create table half (id int); select 1/0;"),
      mig("20261003000000", "create table never (id int);"),
    ]);
    const { deploy, probe, result } = run(store);
    const out = await result;

    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/failed: division by zero/);
    expect(deploy).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
    expect(await tables()).toEqual(["ok_one"]);
    expect(store.patches.find((p) => "image_tag" in p)).toBeUndefined();
    // the first migration stayed applied, so the school's recorded version moves to it
    expect(store.patches).toContainEqual({ schema_version: "20261001000000" });
    expect(store.completions).toHaveLength(1);
    expect(store.completions[0]).toMatchObject({ ok: false });
    expect((store.completions[0].result as { applied: string[] }).applied).toEqual([
      "20261001000000_m",
    ]);
    expect(store.runs.map((r) => r.status)).toEqual(["succeeded", "failed"]);
  });

  it("refuses a contract migration for a school on an older app, before migrating anything", async () => {
    const store = storeWith([
      mig("20261001000000", "create table a (id int);"),
      mig("20261002000000", "create table b (id int);", {
        kind: "contract",
        minAppVersion: TAG_NEW,
      }),
    ]);
    const { deploy, result } = run(store);
    const out = await result;
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/contract migration that needs app version/);
    expect(await tables()).toEqual([]);
    expect(deploy).not.toHaveBeenCalled();
  });

  it("fails the step when the deploy fails, leaving migrations applied and the tag unchanged", async () => {
    const store = storeWith([mig("20261001000000", "create table a (id int);")]);
    const deploy = vi.fn(async (): Promise<DeployOutcome> => ({
      ok: false,
      code: 10,
      status: "rolled_back",
      tag: TAG_OLD,
      message: "The new version was not healthy; the server rolled back to the old one.",
    }));
    const { probe, result } = run(store, { deploy });
    const out = await result;
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/Deploy failed: .*rolled back/);
    expect(probe).not.toHaveBeenCalled();
    expect(await tables()).toEqual(["a"]);
    expect(store.patches.find((p) => "image_tag" in p)).toBeUndefined();
    expect(deploy).toHaveBeenCalledTimes(1);
  });

  it("rolls the deploy back when the deep probe fails afterwards", async () => {
    const store = storeWith([]);
    const deploy = vi.fn(async (): Promise<DeployOutcome> => okDeploy);
    const probe = vi.fn(async (): Promise<ProbeResult> => ({
      ok: false,
      httpStatus: 503,
      latencyMs: 9,
      version: TAG_NEW,
      error: "database check failed",
    }));
    const out = await run(store, { deploy, probe }).result;
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(
      /Health check failed after deploy: database check failed\. The deploy was rolled back/
    );
    expect(
      (deploy.mock.calls as unknown[][]).map((c) => (c[0] as { action: string }).action)
    ).toEqual(["deploy", "rollback"]);
    expect(store.patches.find((p) => "image_tag" in p)).toBeUndefined();
  });

  it("rolls back when the school reports a different version than the one deployed", async () => {
    const store = storeWith([]);
    const deploy = vi.fn(async (): Promise<DeployOutcome> => okDeploy);
    const probe = vi.fn(async (): Promise<ProbeResult> => ({
      ...okProbe,
      version: "f".repeat(40),
    }));
    const out = await run(store, { deploy, probe }).result;
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/reports version ffffffffffff, not 222222222222/);
    expect(deploy).toHaveBeenCalledTimes(2);
  });

  it("says so loudly when the rollback itself fails", async () => {
    const store = storeWith([]);
    const deploy = vi.fn(async (cmd: { action: string }): Promise<DeployOutcome> =>
      cmd.action === "deploy"
        ? okDeploy
        : { ok: false, code: 11, status: "error", tag: "", message: "no" }
    );
    const probe = vi.fn(async (): Promise<ProbeResult> => ({
      ...okProbe,
      ok: false,
      error: "down",
    }));
    const out = await run(store, { deploy: deploy as never, probe }).result;
    expect(out.error).toMatch(/rollback FAILED: check the server/);
  });

  it("does not roll back a deploy it did not make when the probe fails", async () => {
    const store = storeWith([], { image_tag: TAG_NEW });
    const probe = vi.fn(async (): Promise<ProbeResult> => ({
      ...okProbe,
      ok: false,
      error: "down",
    }));
    const { deploy, result } = run(store, { probe });
    const out = await result;
    expect(out.ok).toBe(false);
    expect(deploy).not.toHaveBeenCalled();
    expect(out.error).not.toMatch(/rolled back/);
  });

  it("closes the school connection on success and on failure", async () => {
    const closeOk = vi.fn(async () => {});
    await run(storeWith([mig("20261001000000", "create table a (id int);")]), {
      connect: vi.fn(async () => ({ db, close: closeOk })),
    }).result;
    expect(closeOk).toHaveBeenCalledTimes(1);

    const closeBad = vi.fn(async () => {});
    await run(storeWith([mig("20261002000000", "select 1/0;")]), {
      connect: vi.fn(async () => ({ db, close: closeBad })),
    }).result;
    expect(closeBad).toHaveBeenCalledTimes(1);
  });

  it("reconciles runs left behind by a dead worker before migrating", async () => {
    const store = storeWith([mig("20261001000000", "create table a (id int);")]);
    await run(store).result;
    expect(store.reconcileRuns).toHaveBeenCalledWith("school-1", []);
    const reconcileAt = store.calls.indexOf("completeStep");
    expect(reconcileAt).toBeGreaterThanOrEqual(0);
  });

  describe("schema scan", () => {
    it("records the newest applied migration and marks credentials ok, without changing the school", async () => {
      await db.query("create schema supabase_migrations");
      await db.query(
        "create table supabase_migrations.schema_migrations (version text primary key, statements text[], name text)"
      );
      await db.query(
        "insert into supabase_migrations.schema_migrations (version) values ('20261001000000'), ('20261005000000')"
      );
      const store = fakeStore({
        schoolForScan: vi.fn(async () => ({ id: "school-1", slug: "greenfield" })),
      });
      const out = await handleSchemaScan(
        job({ type: "schema_scan", payload: {} }),
        deps(store, { connect: connectTo() }).d
      );
      expect(out).toMatchObject({ ok: true, result: { latest: "20261005000000", count: 2 } });
      expect(store.patches).toEqual([
        { schema_version: "20261005000000", credentials_status: "ok" },
      ]);
      expect(await tables()).toEqual([]);
    });

    it("does not create the migrations table just by looking", async () => {
      const store = fakeStore({
        schoolForScan: vi.fn(async () => ({ id: "school-1", slug: "greenfield" })),
      });
      const out = await handleSchemaScan(
        job({ type: "schema_scan", payload: {} }),
        deps(store, { connect: connectTo() }).d
      );
      expect(out).toMatchObject({ ok: true, result: { latest: null, count: 0 } });
      const has = await db.query(
        "select to_regclass('supabase_migrations.schema_migrations') as t"
      );
      expect(has.rows[0].t).toBeNull();
    });
  });
});

describe("schema scan: connection problems", () => {
  const scanStore = () =>
    fakeStore({ schoolForScan: vi.fn(async () => ({ id: "school-1", slug: "greenfield" })) });
  const failing = (code: string, message = "nope") =>
    vi.fn(async () => {
      throw Object.assign(new Error(message), { code });
    });

  it.each([
    ["28P01", "auth_failed"],
    ["28000", "auth_failed"],
    ["ENOTFOUND", "unreachable"],
    ["ECONNREFUSED", "unreachable"],
    ["ETIMEDOUT", "unreachable"],
  ])("marks credentials %s as %s and reports the scan failed", async (code, status) => {
    const store = scanStore();
    const out = await handleSchemaScan(
      job({ type: "schema_scan", payload: {} }),
      deps(store, { connect: failing(code) }).d
    );
    expect(out.ok).toBe(false);
    expect(store.patches).toEqual([{ credentials_status: status }]);
  });

  it("leaves credentials_status alone for an error it cannot classify", async () => {
    const store = scanStore();
    await handleSchemaScan(
      job({ type: "schema_scan", payload: {} }),
      deps(store, { connect: failing("XX000", "weird") }).d
    );
    expect(store.patches).toEqual([]);
  });

  it("fails a scan with no school", async () => {
    const out = await handleSchemaScan(
      job({ type: "schema_scan", school_id: null, payload: {} }),
      deps(fakeStore()).d
    );
    expect(out.ok).toBe(false);
  });

  it("redacts secrets from the reported error", async () => {
    const connect = failing("ECONNREFUSED", `could not connect to ${DB_URL}`);
    const out = await handleSchemaScan(
      job({ type: "schema_scan", payload: {} }),
      deps(scanStore(), { connect }).d
    );
    expect(out.error).not.toContain("s3cretPassw0rd");
  });
});

describe("classifyConnectError", () => {
  it("recognises timeouts by message too", () => {
    expect(classifyConnectError(new Error("Connection terminated due to connection timeout"))).toBe(
      "unreachable"
    );
    expect(classifyConnectError(new Error("something else"))).toBeNull();
    expect(classifyConnectError(null)).toBeNull();
  });
});
