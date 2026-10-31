import { beforeEach, describe, expect, it, vi } from "vitest";
import { checksumOf } from "@/lib/migrate/parse";
import type { PgLike, RunnerMigration } from "@/lib/migrate/runner";
import type { DeployCommand, DeployOutcome } from "@/lib/deploy/client";
import type { ProbeResult } from "@/lib/health";
import { EnvSecrets } from "@/worker/secrets";
import type { HandlerDeps } from "@/worker/handlers";
import type { AuthAdmin } from "@/worker/auth-admin";
import { handleProvisionSchool } from "@/worker/provision";
import type { LicenseForPush, ProvisionContext } from "@/worker/store";
import { fakeStore, job } from "@/tests/helpers/fake-store";

const TAG = "a".repeat(40);
const OTHER = "b".repeat(40);
const DB_URL = "postgres://postgres:databasePassw0rd@db.example.supabase.co:5432/postgres";
const APP_ENV = {
  SUPABASE_URL: "https://abcdefgh.supabase.co",
  SUPABASE_ANON_KEY: "anon-key-value",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key-value",
  R2_ENDPOINT: "https://acct123.r2.cloudflarestorage.com",
  R2_BUCKET: "greenfield-files",
  R2_ACCESS_KEY_ID: "r2-key-id-value",
  R2_SECRET_ACCESS_KEY: "r2-secret-value-1234",
  IMPERSONATION_SIGNING_SECRET: "s".repeat(64),
};
const secrets = new EnvSecrets(
  JSON.stringify({ greenfield: DB_URL }),
  JSON.stringify({ greenfield: APP_ENV })
);

const sql = "select 1";
const mig = (version: string): RunnerMigration => ({
  id: `id-${version}`,
  version,
  name: `${version}_m`,
  sql,
  checksum: checksumOf(sql),
  kind: "expand",
  minAppVersion: null,
  releaseSeq: 1,
});

// A database that answers the runner's own queries and nothing else.
function fakeDb(
  opts: {
    applied?: string[];
    publicTables?: number;
    failOn?: RegExp;
    existingAdmin?: { id: string; role: string };
    failProfile?: boolean;
  } = {}
) {
  const applied = [...(opts.applied ?? [])];
  const seen: string[] = [];
  const db: PgLike = {
    async query(text, values) {
      seen.push(text);
      if (/pg_try_advisory_lock/.test(text)) return { rows: [{ ok: true }] };
      if (/set_license/.test(text)) return { rows: [{ applied: true }] };
      if (/from profile_contacts c join profiles p/.test(text)) {
        return { rows: opts.existingAdmin ? [opts.existingAdmin] : [] };
      }
      if (/insert into profiles/.test(text)) {
        if (opts.failProfile) throw new Error("profiles insert failed");
        return { rows: [] };
      }
      if (/information_schema\.tables/.test(text)) {
        return { rows: [{ n: opts.publicTables ?? 0 }] };
      }
      if (/select version from supabase_migrations/.test(text)) {
        return { rows: applied.map((version) => ({ version })) };
      }
      if (/insert into supabase_migrations/.test(text)) {
        applied.push(String(values?.[0]));
        return { rows: [] };
      }
      if (opts.failOn?.test(text)) throw new Error("syntax error near select");
      return { rows: [] };
    },
  };
  return { db, applied, seen };
}

const context = (
  over: {
    school?: Partial<ProvisionContext["school"]>;
    release?: ProvisionContext["release"];
    steps?: ProvisionContext["steps"];
  } = {}
): ProvisionContext => ({
  school: {
    id: "school-1",
    slug: "greenfield",
    status: "provisioning",
    hostnames: ["green.example.com"],
    supabase_project_ref: "abcdefgh",
    r2_bucket: "greenfield-files",
    first_admin_name: "Ada Obi",
    first_admin_email: "Ada@Greenfield.example.com",
    ...over.school,
  },
  release: "release" in over ? over.release! : { seq: 1, image_tag: TAG },
  steps: over.steps ?? {},
});

const licence: LicenseForPush = {
  id: "school-1",
  slug: "greenfield",
  license_version: 1,
  license_pushed_version: 0,
  license_session: "2026/2027",
  license_is_trial: true,
  license_valid_until: "2026-12-01T23:59:59.000Z",
  license_grace_until: "2026-12-15T23:59:59.000Z",
  included_students: 300,
  features: [],
};

const ok = (status: string, tag = TAG, code: number | null = 0): DeployOutcome => ({
  ok: true,
  code,
  status,
  tag,
  message: "",
});
const fail = (code: number, message: string): DeployOutcome => ({
  ok: false,
  code,
  status: "error",
  tag: "",
  message,
});
const healthy: ProbeResult = {
  ok: true,
  httpStatus: 200,
  latencyMs: 10,
  version: TAG,
  error: null,
};

type Setup = {
  ctx?: ProvisionContext | null;
  db?: ReturnType<typeof fakeDb>;
  deploy?: (cmd: DeployCommand) => Promise<DeployOutcome>;
  probe?: () => Promise<ProbeResult>;
  storage?: HandlerDeps["checkStorage"];
  lic?: LicenseForPush | null;
  auth?: Partial<AuthAdmin>;
  noTelegram?: boolean;
};

function setup(s: Setup = {}) {
  const db = s.db ?? fakeDb();
  const store = fakeStore({
    provisionContext: vi.fn(async () => (s.ctx === undefined ? context() : s.ctx)),
    registeredMigrations: vi.fn(async () => [mig("20260101000000"), mig("20260102000000")]),
    releaseSeqs: vi.fn(async () => new Map([[TAG, 1]])),
    licenseForPush: vi.fn(async () => (s.lic === undefined ? licence : s.lic)),
  });
  const deploy = vi.fn(
    s.deploy ??
      (async (cmd: DeployCommand) => (cmd.action === "status" ? ok("stopped", "") : ok("ok")))
  );
  const probe = vi.fn(s.probe ?? (async () => healthy));
  const checkStorage = vi.fn(s.storage ?? (async () => ({ ok: true as const })));
  const sleep = vi.fn(async () => {});
  const connect = vi.fn(async () => ({ db: db.db, close: async () => {} }));
  const send = vi.fn(async (_text: string) => {});
  const createUser = vi.fn(async () => ({ ok: true as const, id: "user-1" }));
  const deleteUser = vi.fn(async () => {});
  const authAdmin: AuthAdmin = { createUser, deleteUser, ...s.auth };
  const deps: HandlerDeps = {
    store,
    secrets,
    connect,
    deploy,
    probe,
    backup: { create: vi.fn(), remove: vi.fn() } as never,
    backupKeep: 10,
    log: () => {},
    checkStorage,
    sleep,
    healthAttempts: 3,
    telegram: s.noTelegram ? undefined : { send },
    authAdmin,
  };
  return {
    store,
    deps,
    db,
    deploy,
    probe,
    checkStorage,
    sleep,
    connect,
    send,
    createUser,
    deleteUser,
  };
}

const run = (deps: HandlerDeps) =>
  handleProvisionSchool(
    job({ type: "provision_school", payload: { by: "owner@example.com" } }),
    deps
  );
const recorded = (store: ReturnType<typeof fakeStore>) =>
  store.provisioning.map((p) => `${p.step}:${p.status}`);

beforeEach(() => vi.clearAllMocks());

describe("provisioning: the whole way", () => {
  it("runs the six steps in order, each recorded running then succeeded, and goes live", async () => {
    const t = setup();
    const out = await run(t.deps);

    expect(out).toMatchObject({ ok: true, result: { tag: TAG } });
    expect(recorded(t.store)).toEqual([
      "database:running",
      "database:succeeded",
      "storage:running",
      "storage:succeeded",
      "container:running",
      "container:succeeded",
      "license:running",
      "license:succeeded",
      "admin:running",
      "admin:succeeded",
      "health:running",
      "health:succeeded",
      "activate:running",
      "activate:succeeded",
    ]);
    expect(t.db.applied).toEqual(["20260101000000", "20260102000000"]);
    expect(t.store.activateSchool).toHaveBeenCalledWith("school-1", TAG, null, "owner@example.com");
    expect(t.store.recordLicensePush).toHaveBeenCalledWith("school-1", 1, true, null);
    expect(t.send).toHaveBeenCalledWith(expect.stringContaining("greenfield is live"));
  });

  it("creates the container with the env file, the hostnames and the latest release", async () => {
    const t = setup();
    await run(t.deps);
    const create = t.deploy.mock.calls.map((c) => c[0]).find((c) => c.action === "create");
    expect(create).toMatchObject({
      action: "create",
      slug: "greenfield",
      tag: TAG,
      hostnames: ["green.example.com"],
    });
    const env = (create as { env: string }).env;
    expect(env.startsWith("SCHOOL_SLUG=greenfield\n")).toBe(true);
    expect(env).toContain("SUPABASE_SERVICE_ROLE_KEY=service-role-key-value");
  });

  it("starts the new school on the release being deployed, so a contract migration is allowed", async () => {
    const t = setup();
    t.store.registeredMigrations = vi.fn(async () => [
      { ...mig("20260101000000"), kind: "contract" as const, minAppVersion: TAG },
    ]);
    const out = await run(t.deps);
    expect(out.ok).toBe(true);
    expect(t.db.applied).toEqual(["20260101000000"]);
  });

  it("records the schema version and credentials as good after the database step", async () => {
    const t = setup();
    await run(t.deps);
    expect(t.store.patches).toContainEqual({
      schema_version: "20260102000000",
      credentials_status: "ok",
    });
  });
});

describe("provisioning: resuming", () => {
  it("does not repeat a step that already succeeded", async () => {
    const t = setup({ ctx: context({ steps: { database: "succeeded", storage: "succeeded" } }) });
    const out = await run(t.deps);
    expect(out.ok).toBe(true);
    expect(t.checkStorage).not.toHaveBeenCalled();
    expect(t.db.seen.some((q) => /information_schema/.test(q))).toBe(false);
    expect(recorded(t.store)[0]).toBe("container:running");
    expect(out).toMatchObject({
      result: { completed: expect.arrayContaining(["database", "storage"]) },
    });
  });

  it("treats a job that finds the school already live as done", async () => {
    const t = setup({
      ctx: context({ school: { status: "active" }, steps: { activate: "succeeded" } }),
    });
    expect(await run(t.deps)).toEqual({ ok: true, result: { skipped: "already active" } });
    expect(t.store.recordProvisionStep).not.toHaveBeenCalled();
  });

  it("refuses a school that is not being provisioned", async () => {
    for (const status of ["active", "suspended", "archived"]) {
      const t = setup({ ctx: context({ school: { status } }) });
      const out = await run(t.deps);
      expect(out).toMatchObject({ ok: false, error: expect.stringContaining(status) });
      expect(t.connect).not.toHaveBeenCalled();
      expect(t.deploy).not.toHaveBeenCalled();
    }
  });

  it("fails cleanly when the school, the release or the hostname is missing", async () => {
    expect(await run(setup({ ctx: null }).deps)).toMatchObject({
      ok: false,
      error: /does not exist/,
    });
    expect(await run(setup({ ctx: context({ release: null }) }).deps)).toMatchObject({
      ok: false,
      error: /No release/,
    });
    expect(await run(setup({ ctx: context({ school: { hostnames: [] } }) }).deps)).toMatchObject({
      ok: false,
      error: /no hostname/,
    });
  });
});

describe("provisioning: each step can fail, and stops everything after it", () => {
  it("refuses bad container settings before touching any database", async () => {
    const t = setup({ ctx: context({ school: { supabase_project_ref: "someoneelse" } }) });
    const out = await run(t.deps);
    expect(out).toMatchObject({ ok: false, error: /database: .*not this school's project/ });
    expect(t.connect).not.toHaveBeenCalled();
    expect(recorded(t.store)).toEqual(["database:running", "database:failed"]);
  });

  it("reports an unreachable database and remembers the credentials problem", async () => {
    const t = setup();
    t.deps.connect = vi.fn(async () => {
      throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    });
    const out = await run(t.deps);
    expect(out).toMatchObject({ ok: false, error: /Could not connect/ });
    expect(t.store.patches).toContainEqual({ credentials_status: "unreachable" });
    expect(t.checkStorage).not.toHaveBeenCalled();
  });

  it("refuses a database that already has tables and no history: that is an existing school", async () => {
    const t = setup({ db: fakeDb({ publicTables: 12 }) });
    const out = await run(t.deps);
    expect(out).toMatchObject({ ok: false, error: /adopt-school/ });
    expect(t.db.applied).toEqual([]);
    expect(t.checkStorage).not.toHaveBeenCalled();
  });

  it("lets a half-provisioned database carry on from its own history", async () => {
    const t = setup({ db: fakeDb({ applied: ["20260101000000"], publicTables: 12 }) });
    const out = await run(t.deps);
    expect(out.ok).toBe(true);
    expect(t.db.applied).toEqual(["20260101000000", "20260102000000"]);
  });

  it("stops at a failing migration and records how far the database got", async () => {
    const t = setup({ db: fakeDb({ failOn: /select 1/ }) });
    const out = await run(t.deps);
    expect(out).toMatchObject({ ok: false, error: /database: .*_m failed/ });
    expect(t.checkStorage).not.toHaveBeenCalled();
    expect(t.deploy).not.toHaveBeenCalled();
  });

  it("stops at a bucket the key cannot use, and never prints the key", async () => {
    const t = setup({
      storage: async () => ({
        ok: false,
        error: `Writing to the bucket failed: AccessDenied for ${APP_ENV.R2_SECRET_ACCESS_KEY}`,
      }),
    });
    const out = await run(t.deps);
    expect(out).toMatchObject({ ok: false, error: /storage: Writing to the bucket failed/ });
    expect(JSON.stringify(out)).not.toContain(APP_ENV.R2_SECRET_ACCESS_KEY);
    expect(t.store.provisioning.find((p) => p.status === "failed")?.detail ?? "").not.toContain(
      APP_ENV.R2_SECRET_ACCESS_KEY
    );
    expect(t.deploy).not.toHaveBeenCalled();
  });

  it("does not touch a server that already has this school at another version", async () => {
    const t = setup({ deploy: async () => ok("running", OTHER) });
    const out = await run(t.deps);
    expect(out).toMatchObject({ ok: false, error: /already has greenfield/ });
    expect(t.deploy.mock.calls.map((c) => c[0].action)).toEqual(["status"]);
  });

  it("carries on when the server already runs this school at this release", async () => {
    const t = setup({ deploy: async () => ok("running", TAG) });
    const out = await run(t.deps);
    expect(out.ok).toBe(true);
    expect(t.deploy.mock.calls.map((c) => c[0].action)).toEqual(["status"]);
  });

  it("cannot read the server: stops without changing anything", async () => {
    const t = setup({ deploy: async () => fail(255, "Could not connect to the server over SSH.") });
    const out = await run(t.deps);
    expect(out).toMatchObject({ ok: false, error: /Could not read the server's state/ });
    expect(t.deploy).toHaveBeenCalledTimes(1);
  });

  it("removes a container left without a route (exit 13) so Resume starts clean", async () => {
    const t = setup({
      deploy: async (cmd) =>
        cmd.action === "status"
          ? ok("stopped", "")
          : cmd.action === "create"
            ? fail(13, "The proxy would not load the route.")
            : ok("ok", ""),
    });
    const out = await run(t.deps);
    expect(out).toMatchObject({ ok: false, error: /proxy.*removed/ });
    expect(t.deploy.mock.calls.map((c) => c[0].action)).toEqual(["status", "create", "remove"]);
  });

  it("says so when that cleanup also fails", async () => {
    const t = setup({
      deploy: async (cmd) =>
        cmd.action === "status"
          ? ok("stopped", "")
          : cmd.action === "create"
            ? fail(13, "The proxy would not load the route.")
            : fail(255, "ssh down"),
    });
    expect(await run(t.deps)).toMatchObject({ ok: false, error: /could NOT be removed/ });
  });

  it("stops when the container cannot be created, with the server's reason", async () => {
    const t = setup({
      deploy: async (cmd) =>
        cmd.action === "status" ? ok("stopped", "") : fail(15, "The image could not be pulled."),
    });
    const out = await run(t.deps);
    expect(out).toMatchObject({ ok: false, error: /container: Create failed: .*pulled/ });
    expect(t.deploy.mock.calls.map((c) => c[0].action)).toEqual(["status", "create"]);
  });

  it("fails the licence step when the school's database refuses the licence", async () => {
    const t = setup({ lic: null });
    const out = await run(t.deps);
    expect(out).toMatchObject({ ok: false, error: /license: / });
    expect(t.probe).not.toHaveBeenCalled();
  });

  it("fails the licence step when no licence was saved", async () => {
    const t = setup({ lic: { ...licence, license_valid_until: null } });
    expect(await run(t.deps)).toMatchObject({ ok: false, error: /no licence saved/ });
  });
});

describe("provisioning: the first admin", () => {
  it("creates the login and the profile rows, and sends the password only on Telegram", async () => {
    const t = setup();
    const out = await run(t.deps);
    expect(out.ok).toBe(true);
    expect(t.createUser).toHaveBeenCalledWith(
      { url: APP_ENV.SUPABASE_URL, serviceRoleKey: APP_ENV.SUPABASE_SERVICE_ROLE_KEY },
      {
        email: "ada@greenfield.example.com",
        password: expect.stringMatching(/^[a-z]+(-[a-z]+){3}-\d{3}$/),
      }
    );
    const password = (t.createUser.mock.calls[0] as unknown as [unknown, { password: string }])[1]
      .password;
    const message = t.send.mock.calls
      .map((c) => c[0])
      .find((m) => m.includes("Temporary password"));
    expect(message).toContain(password);
    expect(message).toContain("ada@greenfield.example.com");
    expect(JSON.stringify(out)).not.toContain(password);
    expect(JSON.stringify(t.store.provisioning)).not.toContain(password);
    expect(t.db.seen.some((q) => /insert into profiles/.test(q) && /'admin'/.test(q))).toBe(true);
    expect(t.db.seen.some((q) => /insert into profile_contacts/.test(q))).toBe(true);
  });

  it("refuses without Telegram, before creating anything", async () => {
    const t = setup({ noTelegram: true });
    const out = await run(t.deps);
    expect(out).toMatchObject({ ok: false, error: /admin: Telegram is not set up/ });
    expect(t.createUser).not.toHaveBeenCalled();
    expect(t.probe).not.toHaveBeenCalled();
  });

  it("refuses a school with no first admin saved", async () => {
    const t = setup({ ctx: context({ school: { first_admin_email: null } }) });
    expect(await run(t.deps)).toMatchObject({ ok: false, error: /no first admin/ });
    expect(t.createUser).not.toHaveBeenCalled();
  });

  it("does not make a second login when the admin already exists (a resume)", async () => {
    const t = setup({ db: fakeDb({ existingAdmin: { id: "u", role: "admin" } }) });
    const out = await run(t.deps);
    expect(out.ok).toBe(true);
    expect(t.createUser).not.toHaveBeenCalled();
    expect(t.send.mock.calls.some((c) => /Temporary password/.test(c[0]))).toBe(false);
  });

  it("refuses an email that already belongs to someone who is not an admin", async () => {
    const t = setup({ db: fakeDb({ existingAdmin: { id: "u", role: "teacher" } }) });
    expect(await run(t.deps)).toMatchObject({ ok: false, error: /not an admin/ });
    expect(t.createUser).not.toHaveBeenCalled();
  });

  it("reports a login the school's Auth refused", async () => {
    const t = setup({
      auth: { createUser: async () => ({ ok: false, error: "email rate limit" }) },
    });
    expect(await run(t.deps)).toMatchObject({
      ok: false,
      error: /Could not create the login: email rate limit/,
    });
  });

  it("removes everything it made when the password cannot be delivered", async () => {
    const t = setup();
    t.send.mockImplementation(async (text: string) => {
      if (/Temporary password/.test(text)) throw new Error("telegram down");
    });
    const out = await run(t.deps);
    expect(out).toMatchObject({ ok: false, error: /not kept.*telegram down.*Resume starts clean/ });
    expect(t.deleteUser).toHaveBeenCalledWith(expect.anything(), "user-1");
    expect(t.db.seen.some((q) => /delete from profiles/.test(q))).toBe(true);
    expect(t.probe).not.toHaveBeenCalled();
  });

  it("removes the login when the profile rows cannot be written", async () => {
    const t = setup({ db: fakeDb({ failProfile: true }) });
    const out = await run(t.deps);
    expect(out).toMatchObject({ ok: false, error: /not kept.*profiles insert failed/ });
    expect(t.deleteUser).toHaveBeenCalledWith(expect.anything(), "user-1");
    expect(t.send.mock.calls.some((c) => /Temporary password/.test(c[0]))).toBe(false);
  });
});

describe("provisioning: the health check", () => {
  it("tries again while DNS and the certificate settle", async () => {
    let calls = 0;
    const t = setup({
      probe: async () =>
        ++calls < 3
          ? { ok: false, httpStatus: null, latencyMs: 1, version: null, error: "ENOTFOUND" }
          : healthy,
    });
    const out = await run(t.deps);
    expect(out.ok).toBe(true);
    expect(t.probe).toHaveBeenCalledTimes(3);
    expect(t.sleep).toHaveBeenCalledTimes(2);
  });

  it("gives up with a DNS hint, and does not go live", async () => {
    const t = setup({
      probe: async () => ({
        ok: false,
        httpStatus: null,
        latencyMs: 1,
        version: null,
        error: "ENOTFOUND",
      }),
    });
    const out = await run(t.deps);
    expect(out).toMatchObject({ ok: false, error: /health: .*ENOTFOUND.*DNS record/ });
    expect(t.probe).toHaveBeenCalledTimes(3);
    expect(t.store.activateSchool).not.toHaveBeenCalled();
  });

  it("does not accept a school running some other version", async () => {
    const t = setup({ probe: async () => ({ ...healthy, version: OTHER }) });
    expect(await run(t.deps)).toMatchObject({ ok: false, error: /reports version bbbbbbbbbbbb/ });
    expect(t.store.activateSchool).not.toHaveBeenCalled();
  });
});

describe("provisioning: unexpected trouble", () => {
  it("lets an infrastructure error propagate, so the worker retries the job", async () => {
    const t = setup();
    t.store.registeredMigrations = vi.fn(async () => {
      throw new Error("load registry: fetch failed");
    });
    await expect(run(t.deps)).rejects.toThrow(/fetch failed/);
    // The step stays "running" in the record; a retry runs it again.
    expect(recorded(t.store)).toEqual(["database:running"]);
  });

  it("does not let a failing Telegram notice change the outcome", async () => {
    const t = setup();
    // Only the "is live" notice fails; the password message (a real step) is not this case.
    t.send.mockImplementation(async (text: string) => {
      if (/is live/.test(text)) throw new Error("telegram down");
    });
    expect((await run(t.deps)).ok).toBe(true);
  });

  it("tells you on Telegram where it stopped", async () => {
    const t = setup({ storage: async () => ({ ok: false, error: "AccessDenied" }) });
    await run(t.deps);
    expect(t.send).toHaveBeenCalledWith(expect.stringMatching(/greenfield stopped at "storage"/));
  });
});
