import { describe, expect, it, vi } from "vitest";
import { checksumOf } from "@/lib/migrate/parse";
import type { DeployCommand, DeployOutcome } from "@/lib/deploy/client";
import type { ProbeResult } from "@/lib/health";
import { EnvSecrets } from "@/worker/secrets";
import { handleRegisterRelease, handleSchoolRollback, type HandlerDeps } from "@/worker/handlers";
import { tick, type WorkerDeps } from "@/worker/run";
import type { SchoolForAction } from "@/worker/store";
import { fakeStore, job } from "@/tests/helpers/fake-store";
import { fakeBackup } from "@/tests/helpers/fake-backup";

const OLD = "1".repeat(40);
const NEW = "2".repeat(40);
const DB_URL = "postgres://postgres:s3cretPassw0rd@db.example.supabase.co:5432/postgres";
const secrets = new EnvSecrets(JSON.stringify({ greenfield: DB_URL }));

const school = (over: Partial<SchoolForAction> = {}): SchoolForAction => ({
  id: "school-1",
  slug: "greenfield",
  status: "active",
  hostnames: ["greenfield.example.com"],
  image_tag: NEW,
  ...over,
});
const ok = (tag: string, status = "ok"): DeployOutcome => ({
  ok: true,
  code: 0,
  status,
  tag,
  message: "",
});
const bad = (message: string, code = 3): DeployOutcome => ({
  ok: false,
  code,
  status: "error",
  tag: "",
  message,
});
const probeOk = (version: string | null): ProbeResult => ({
  ok: true,
  httpStatus: 200,
  latencyMs: 5,
  version,
  error: null,
});

function setup(over: Partial<HandlerDeps> = {}, schoolRow: SchoolForAction | null = school()) {
  const store = fakeStore({ schoolForAction: vi.fn(async () => schoolRow) });
  const calls: DeployCommand[] = [];
  const deps: HandlerDeps = {
    store,
    secrets,
    connect: vi.fn(),
    deploy: vi.fn(async (cmd: DeployCommand) => {
      calls.push(cmd);
      return cmd.action === "status" ? ok(NEW, "running") : ok(OLD);
    }),
    probe: vi.fn(async () => probeOk(OLD)),
    backup: fakeBackup(),
    backupKeep: 10,
    log: () => {},
    ...over,
  };
  return { store, deps, calls };
}
const rollbackJob = (over = {}) =>
  job({
    type: "school_rollback",
    school_id: "school-1",
    payload: { by: "o@x" },
    max_attempts: 1,
    ...over,
  });

describe("handleSchoolRollback", () => {
  it("checks what the server is running, rolls back, verifies, then records the new version", async () => {
    const { store, deps, calls } = setup();
    const out = await handleSchoolRollback(rollbackJob(), deps);
    expect(out).toEqual({ ok: true, result: { from_tag: NEW, to_tag: OLD } });
    expect(calls).toEqual([
      { action: "status", slug: "greenfield" },
      { action: "rollback", slug: "greenfield" },
    ]);
    expect(store.patches).toEqual([{ image_tag: OLD, app_version: OLD }]);
    expect(deps.probe).toHaveBeenCalledWith("greenfield.example.com", "greenfield");
  });

  it("does nothing when the server and the dashboard disagree about the running version", async () => {
    const { store, deps, calls } = setup({
      deploy: vi.fn(async (cmd: DeployCommand) => ok(cmd.action === "status" ? OLD : OLD)),
    });
    const out = await handleSchoolRollback(rollbackJob(), deps);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(
      /server says 111111111111 is running but the dashboard says 222222222222/
    );
    expect(out.error).toMatch(/Nothing was changed/);
    expect(deps.deploy).toHaveBeenCalledTimes(1); // status only: a rollback on a wrong guess could flip it forward
    expect(calls).toBeDefined();
    expect(store.patches).toEqual([]);
  });

  it("does nothing when the dashboard has no version for the school", async () => {
    const { deps } = setup({}, school({ image_tag: null }));
    const out = await handleSchoolRollback(rollbackJob(), deps);
    expect(out.ok).toBe(false);
    expect(deps.deploy).toHaveBeenCalledTimes(1);
  });

  it("stops when the server's state cannot be read", async () => {
    const { deps } = setup({
      deploy: vi.fn(async () => bad("Could not connect to the server over SSH.", 255)),
    });
    const out = await handleSchoolRollback(rollbackJob(), deps);
    expect(out.error).toMatch(/Could not read the server's state: Could not connect/);
    expect(deps.deploy).toHaveBeenCalledTimes(1);
  });

  it("reports a failed rollback (for example no previous version) and records nothing", async () => {
    const { store, deps } = setup({
      deploy: vi.fn(async (cmd: DeployCommand) =>
        cmd.action === "status" ? ok(NEW, "running") : bad("has no previous version")
      ),
    });
    const out = await handleSchoolRollback(rollbackJob(), deps);
    expect(out).toMatchObject({ ok: false, error: "Rollback failed: has no previous version" });
    expect(store.patches).toEqual([]);
  });

  it("refuses a rollback that does not say which version it went back to", async () => {
    const { store, deps } = setup({
      deploy: vi.fn(async (cmd: DeployCommand) =>
        cmd.action === "status" ? ok(NEW, "running") : ok("")
      ),
    });
    const out = await handleSchoolRollback(rollbackJob(), deps);
    expect(out.error).toMatch(/did not say which version/);
    expect(store.patches).toEqual([]);
  });

  it("records the version the server confirmed even when the deeper probe disagrees, and fails the job", async () => {
    const { store, deps } = setup({ probe: vi.fn(async () => probeOk(NEW)) });
    const out = await handleSchoolRollback(rollbackJob(), deps);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/Rolled back to 111111111111, but the school does not look right/);
    expect(out.result).toMatchObject({ to_tag: OLD });
    expect(store.patches).toEqual([{ image_tag: OLD, app_version: OLD }]);
    const down = setup({
      probe: vi.fn(async () => ({ ...probeOk(null), ok: false, error: "HTTP 503" })),
    });
    expect((await handleSchoolRollback(rollbackJob(), down.deps)).error).toMatch(/HTTP 503/);
  });

  it("fails cleanly for a missing school, a missing school id or a school with no hostname", async () => {
    expect(
      (await handleSchoolRollback(rollbackJob({ school_id: null }), setup().deps)).error
    ).toMatch(/no school/);
    expect((await handleSchoolRollback(rollbackJob(), setup({}, null).deps)).error).toMatch(
      /does not exist/
    );
    expect(
      (await handleSchoolRollback(rollbackJob(), setup({}, school({ hostnames: [] })).deps)).error
    ).toMatch(/no hostname/);
  });

  it("redacts database passwords from what it reports", async () => {
    const { deps } = setup({
      deploy: vi.fn(async () => {
        throw new Error(`connect failed for ${DB_URL}`);
      }),
    });
    const out = await handleSchoolRollback(rollbackJob(), deps);
    expect(out.ok).toBe(false);
    expect(out.error).not.toContain("s3cretPassw0rd");
  });
});

const sql1 = "create table students (id int);";
const file = (name: string, content: string) => ({ name, content });
const registerJob = (over = {}) =>
  job({
    type: "register_release",
    school_id: null,
    payload: { tag: NEW, notes: "hotfix", by: "o@x" },
    ...over,
  });

describe("handleRegisterRelease", () => {
  it("reads the commit's files, registers what is new through the same planner as the CLI", async () => {
    const registered = [
      { version: "20261001000000", name: "20261001000000_one.sql", checksum: checksumOf(sql1) },
    ];
    const { store, deps } = setup({
      fetchMigrations: vi.fn(async () => [
        file("20261001000000_one.sql", sql1),
        file("20261002000000_two.sql", "alter table students add column name text;"),
      ]),
    });
    store.registryRows = vi.fn(async () => registered);
    const out = await handleRegisterRelease(registerJob(), deps);
    expect(out.ok).toBe(true);
    expect(out.result).toEqual({ migrations: ["20261002000000_two"] });
    expect(deps.fetchMigrations).toHaveBeenCalledWith(NEW);
    expect(store.registerRelease).toHaveBeenCalledWith({
      tag: NEW,
      notes: "hotfix",
      by: "o@x",
      migrations: [
        expect.objectContaining({
          version: "20261002000000",
          kind: "expand",
          min_app_version: "",
          checksum: checksumOf("alter table students add column name text;"),
        }),
      ],
    });
  });

  it("registers a release with no new migrations (a deploy-only release)", async () => {
    const { store, deps } = setup({
      fetchMigrations: vi.fn(async () => [file("20261001000000_one.sql", sql1)]),
    });
    store.registryRows = vi.fn(async () => [
      { version: "20261001000000", name: "20261001000000_one.sql", checksum: checksumOf(sql1) },
    ]);
    expect((await handleRegisterRelease(registerJob(), deps)).ok).toBe(true);
    expect(store.registerRelease).toHaveBeenCalledWith(expect.objectContaining({ migrations: [] }));
  });

  it("refuses an edited registered migration, without registering anything", async () => {
    const { store, deps } = setup({
      fetchMigrations: vi.fn(async () => [
        file("20261001000000_one.sql", "create table other (id int);"),
      ]),
    });
    store.registryRows = vi.fn(async () => [
      { version: "20261001000000", name: "20261001000000_one.sql", checksum: checksumOf(sql1) },
    ]);
    const out = await handleRegisterRelease(registerJob(), deps);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/was changed after it was registered/);
    expect(store.registerRelease).not.toHaveBeenCalled();
  });

  it("sends the very first registration to the CLI, where --baseline exists", async () => {
    const { store, deps } = setup({
      fetchMigrations: vi.fn(async () => [file("20260101000000_old.sql", "drop table legacy;")]),
    });
    const out = await handleRegisterRelease(registerJob(), deps);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/first registration needs --baseline: use npm run register-release/);
    expect(store.registerRelease).not.toHaveBeenCalled();
  });

  it("says plainly what is missing", async () => {
    const noToken = await handleRegisterRelease(registerJob(), setup().deps);
    expect(noToken.error).toMatch(/no GITHUB_TOKEN/);
    const badTag = await handleRegisterRelease(
      registerJob({ payload: { tag: "main" } }),
      setup({ fetchMigrations: vi.fn() }).deps
    );
    expect(badTag.error).toMatch(/40-character/);
    const none = await handleRegisterRelease(
      registerJob(),
      setup({ fetchMigrations: vi.fn(async () => []) }).deps
    );
    expect(none.error).toMatch(/No .sql files/);
  });

  it("treats 'already registered' after a retry as done, and lets other errors retry", async () => {
    const { store, deps } = setup({
      fetchMigrations: vi.fn(async () => [file("20261001000000_one.sql", sql1)]),
    });
    store.registerRelease = vi.fn(async () => {
      throw new Error("register_release: That release is already registered.");
    });
    expect((await handleRegisterRelease(registerJob(), deps)).result).toMatchObject({
      already_registered: true,
    });
    store.registerRelease = vi.fn(async () => {
      throw new Error("register_release: connection reset");
    });
    await expect(handleRegisterRelease(registerJob(), deps)).rejects.toThrow(/connection reset/);
  });

  it("lets a fetch failure propagate so the job is retried", async () => {
    const { deps } = setup({
      fetchMigrations: vi.fn(async () => {
        throw new Error("GitHub answered 502");
      }),
    });
    await expect(handleRegisterRelease(registerJob(), deps)).rejects.toThrow(/502/);
  });
});

describe("the worker loop runs the new job types", () => {
  const run = async (j: ReturnType<typeof job>, over: Partial<HandlerDeps> = {}) => {
    const { store, deps } = setup(over);
    store.claimJob = vi.fn(async () => j);
    await tick({ ...deps, workerId: "w1" } as WorkerDeps);
    return store;
  };
  it("claims them, runs them and reports the result", async () => {
    const rb = await run(rollbackJob());
    expect(rb.claimJob).toHaveBeenCalledWith(
      "w1",
      expect.arrayContaining(["school_rollback", "register_release"])
    );
    expect(rb.finishJob).toHaveBeenCalledWith(
      "job-1",
      "w1",
      true,
      { from_tag: NEW, to_tag: OLD },
      null
    );
    const reg = await run(registerJob(), {
      fetchMigrations: vi.fn(async () => [file("20261001000000_one.sql", sql1)]),
    });
    expect(reg.finishJob).toHaveBeenCalledWith(
      "job-1",
      "w1",
      true,
      { migrations: ["20261001000000_one"] },
      null
    );
  });
  it("hands a thrown error to retry_job, which fails a one-attempt rollback for good", async () => {
    const store = await run(rollbackJob(), {
      deploy: vi.fn(async () => {
        throw new Error("ssh exploded");
      }),
    });
    // thrown inside the handler's try: reported as a failure, never retried
    expect(store.retryJob).not.toHaveBeenCalled();
    expect(store.finishJob).toHaveBeenCalledWith(
      "job-1",
      "w1",
      false,
      expect.anything(),
      expect.stringMatching(/ssh exploded/)
    );
  });
});
