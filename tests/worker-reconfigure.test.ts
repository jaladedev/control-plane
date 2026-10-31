import { generateKeyPairSync } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DeployCommand, DeployOutcome } from "@/lib/deploy/client";
import type { ProbeResult } from "@/lib/health";
import { EnvSecrets } from "@/worker/secrets";
import type { HandlerDeps } from "@/worker/handlers";
import { handleReconfigureSchool } from "@/worker/reconfigure";
import type { ProvisionContext, SchoolForAction } from "@/worker/store";
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
  R2_ACCESS_KEY_ID: "NEW-r2-key-id-value",
  R2_SECRET_ACCESS_KEY: "NEW-r2-secret-value-1234",
  IMPERSONATION_SIGNING_SECRET: "s".repeat(64),
};
const secrets = new EnvSecrets(
  JSON.stringify({ greenfield: DB_URL }),
  JSON.stringify({ greenfield: APP_ENV })
);

const ctx = (school: Partial<ProvisionContext["school"]> = {}): ProvisionContext => ({
  school: {
    id: "school-1",
    slug: "greenfield",
    status: "active",
    hostnames: ["green.example.com"],
    supabase_project_ref: "abcdefgh",
    r2_bucket: "greenfield-files",
    first_admin_name: null,
    first_admin_email: null,
    ...school,
  },
  release: { seq: 1, image_tag: TAG },
  steps: {},
});
const ok = (status: string, tag = TAG): DeployOutcome => ({
  ok: true,
  code: 0,
  status,
  tag,
  message: "",
});
const bad = (code: number, message: string): DeployOutcome => ({
  ok: false,
  code,
  status: "error",
  tag: "",
  message,
});
const healthy: ProbeResult = { ok: true, httpStatus: 200, latencyMs: 9, version: TAG, error: null };

type Setup = {
  ctx?: ProvisionContext | null;
  action?: SchoolForAction | null;
  deploy?: (cmd: DeployCommand) => Promise<DeployOutcome>;
  probe?: () => Promise<ProbeResult>;
  storage?: HandlerDeps["checkStorage"];
  settings?: Record<string, string> | undefined | "none";
};

function setup(s: Setup = {}) {
  const store = fakeStore({
    provisionContext: vi.fn(async () => (s.ctx === undefined ? ctx() : s.ctx)),
    schoolForAction: vi.fn(async () =>
      s.action === undefined
        ? {
            id: "school-1",
            slug: "greenfield",
            status: "active",
            hostnames: ["green.example.com"],
            image_tag: TAG,
          }
        : s.action
    ),
  });
  const deploy = vi.fn(
    s.deploy ?? (async (cmd: DeployCommand) => (cmd.action === "status" ? ok("running") : ok("ok")))
  );
  const probe = vi.fn(s.probe ?? (async () => healthy));
  const checkStorage = vi.fn(s.storage ?? (async () => ({ ok: true as const })));
  const send = vi.fn(async (_t: string) => {});
  const sec =
    s.settings === "none"
      ? new EnvSecrets(JSON.stringify({ greenfield: DB_URL }))
      : s.settings
        ? new EnvSecrets(
            JSON.stringify({ greenfield: DB_URL }),
            JSON.stringify({ greenfield: s.settings })
          )
        : secrets;
  const deps: HandlerDeps = {
    store,
    secrets: sec,
    connect: vi.fn(),
    deploy,
    probe,
    backup: { create: vi.fn(), remove: vi.fn() } as never,
    backupKeep: 10,
    log: () => {},
    checkStorage,
    telegram: { send },
  };
  return { store, deps, deploy, probe, checkStorage, send };
}
const run = (deps: HandlerDeps) =>
  handleReconfigureSchool(job({ type: "reconfigure_school", payload: {} }), deps);
const actions = (t: ReturnType<typeof setup>) => t.deploy.mock.calls.map((c) => c[0].action);

beforeEach(() => vi.clearAllMocks());

// A real claim key pair, in the encoding npm run claim-key prints.
function claimKey() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    seed: privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32).toString("base64url"),
    pub: publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64url"),
  };
}

describe("applying settings to a running school", () => {
  it("checks, confirms with the server, applies on the same tag, then probes", async () => {
    const t = setup();
    const out = await run(t.deps);
    expect(out).toMatchObject({ ok: true, result: { tag: TAG } });
    expect(actions(t)).toEqual(["status", "reconfigure"]);
    expect(t.checkStorage).toHaveBeenCalledWith({
      endpoint: APP_ENV.R2_ENDPOINT,
      bucket: "greenfield-files",
      accessKeyId: APP_ENV.R2_ACCESS_KEY_ID,
      secretAccessKey: APP_ENV.R2_SECRET_ACCESS_KEY,
    });
    expect(t.probe).toHaveBeenCalledWith("green.example.com", "greenfield");
    expect(t.send).toHaveBeenCalledWith(expect.stringContaining("healthy on the new settings"));
  });

  it("sends the new env file, with SCHOOL_SLUG first, and lists only key names in its result", async () => {
    const t = setup();
    const out = await run(t.deps);
    const call = t.deploy.mock.calls.map((c) => c[0]).find((c) => c.action === "reconfigure") as {
      env: string;
      slug: string;
    };
    expect(call.slug).toBe("greenfield");
    expect(call.env.startsWith("SCHOOL_SLUG=greenfield\n")).toBe(true);
    expect(call.env).toContain("R2_SECRET_ACCESS_KEY=NEW-r2-secret-value-1234");
    expect(JSON.stringify(out)).not.toContain("NEW-r2-secret-value-1234");
    expect((out.result as { applied_keys: string[] }).applied_keys).toContain("R2_BUCKET");
  });

  it("changes nothing when the new R2 key does not work", async () => {
    const t = setup({
      storage: async () => ({
        ok: false,
        error: `Writing to the bucket failed: AccessDenied ${APP_ENV.R2_SECRET_ACCESS_KEY}`,
      }),
    });
    const out = await run(t.deps);
    expect(out).toMatchObject({
      ok: false,
      error: /^Nothing was changed\. Writing to the bucket failed/,
    });
    expect(JSON.stringify(out)).not.toContain(APP_ENV.R2_SECRET_ACCESS_KEY);
    expect(t.deploy).not.toHaveBeenCalled();
  });

  it("refuses settings that are incomplete or belong to another school, before any check", async () => {
    const { SUPABASE_SERVICE_ROLE_KEY: _drop, ...partial } = APP_ENV;
    for (const settings of [
      partial,
      { ...APP_ENV, SUPABASE_URL: "https://zzzzzzzz.supabase.co" },
    ]) {
      const t = setup({ settings });
      expect(await run(t.deps)).toMatchObject({ ok: false, error: /settings are not ready/ });
      expect(t.checkStorage).not.toHaveBeenCalled();
      expect(t.deploy).not.toHaveBeenCalled();
    }
    const none = setup({ settings: "none" });
    expect(await run(none.deps)).toMatchObject({ ok: false, error: /no entry for "greenfield"/ });
  });

  it("refuses a school that is not active, has no hostname or has no known version", async () => {
    expect(await run(setup({ ctx: ctx({ status: "suspended" }) }).deps)).toMatchObject({
      ok: false,
      error: /not active/,
    });
    expect(await run(setup({ ctx: ctx({ hostnames: [] }) }).deps)).toMatchObject({
      ok: false,
      error: /no hostname/,
    });
    expect(
      await run(
        setup({
          action: {
            id: "school-1",
            slug: "greenfield",
            status: "active",
            hostnames: ["g.example.com"],
            image_tag: null,
          },
        }).deps
      )
    ).toMatchObject({ ok: false, error: /does not know which version/ });
    expect(await run(setup({ ctx: null }).deps)).toMatchObject({
      ok: false,
      error: /does not exist/,
    });
  });

  it("does nothing when the server and the dashboard disagree about the version", async () => {
    const t = setup({ deploy: async () => ok("running", OTHER) });
    const out = await run(t.deps);
    expect(out).toMatchObject({
      ok: false,
      error: /server says bbbbbbbbbbbb.*dashboard says aaaaaaaaaaaa.*Nothing was changed/,
    });
    expect(actions(t)).toEqual(["status"]);
  });

  it("does nothing when the server's state cannot be read", async () => {
    const t = setup({ deploy: async () => bad(255, "Could not connect to the server over SSH.") });
    expect(await run(t.deps)).toMatchObject({
      ok: false,
      error: /Could not read the server's state/,
    });
    expect(actions(t)).toEqual(["status"]);
  });

  it("says the old settings are back, and not to revoke the old keys, when the server rolled them back", async () => {
    const t = setup({
      deploy: async (cmd) =>
        cmd.action === "status"
          ? ok("running")
          : {
              ok: false,
              code: 10,
              status: "rolled_back",
              tag: TAG,
              message:
                "The school was not healthy on the new settings; the server put the old settings back.",
            },
    });
    const out = await run(t.deps);
    expect(out).toMatchObject({
      ok: false,
      error: /old settings back.*do not revoke the old keys/,
    });
    expect(t.probe).not.toHaveBeenCalled();
    expect(t.send).toHaveBeenCalledWith(
      expect.stringMatching(/Applying settings to greenfield failed/)
    );
  });

  it("reports a failed restart without calling it a rollback", async () => {
    const t = setup({
      deploy: async (cmd) =>
        cmd.action === "status" ? ok("running") : bad(11, "unhealthy on both"),
    });
    const out = await run(t.deps);
    expect(out).toMatchObject({ ok: false, error: /unhealthy on both/ });
    expect(out.error).not.toMatch(/do not revoke/);
  });

  it("does not trust the server's word alone: a school that fails the public probe is an error, with the way back", async () => {
    const t = setup({
      probe: async () => ({
        ok: false,
        httpStatus: 500,
        latencyMs: 4,
        version: null,
        error: "database unreachable",
      }),
    });
    const out = await run(t.deps);
    expect(out).toMatchObject({
      ok: false,
      error:
        /does not look right: database unreachable.*NOT restored automatically.*SCHOOL_APP_ENVS/,
    });
  });

  it("does not accept a school that answers on some other version", async () => {
    const t = setup({ probe: async () => ({ ...healthy, version: OTHER }) });
    expect(await run(t.deps)).toMatchObject({ ok: false, error: /reports version bbbbbbbbbbbb/ });
  });

  it("lets an infrastructure error propagate so the worker can report it", async () => {
    const t = setup();
    t.store.provisionContext = vi.fn(async () => {
      throw new Error("load school: fetch failed");
    });
    await expect(run(t.deps)).rejects.toThrow(/fetch failed/);
  });

  it("does not let a failing Telegram notice change the outcome", async () => {
    const t = setup();
    t.send.mockRejectedValue(new Error("telegram down"));
    expect((await run(t.deps)).ok).toBe(true);
  });
});

describe("a new claim-signing key", () => {
  const withKey = (seed: string) => ({
    ...APP_ENV,
    CONTROL_PLANE_URL: "https://dash.example.com",
    CLAIM_SIGNING_KEY: seed,
  });

  it("is applied once its public key is registered and active", async () => {
    const k = claimKey();
    const t = setup({ settings: withKey(k.seed) });
    vi.mocked(t.store.activeSigningKeys).mockResolvedValue(["some-old-key", k.pub]);
    const out = await run(t.deps);
    expect(out.ok).toBe(true);
    expect(t.store.activeSigningKeys).toHaveBeenCalledWith("school-1");
    expect(actions(t)).toEqual(["status", "reconfigure"]);
  });

  it("is refused, with nothing changed, when its public key is not registered", async () => {
    const k = claimKey();
    const t = setup({ settings: withKey(k.seed) });
    vi.mocked(t.store.activeSigningKeys).mockResolvedValue(["some-old-key"]);
    const out = await run(t.deps);
    expect(out.ok).toBe(false);
    expect(out.error).toContain(k.pub);
    expect(out.error).toContain("Payment claim keys");
    expect(out.error).toContain("Nothing was changed");
    expect(out.error).not.toContain(k.seed);
    expect(t.checkStorage).not.toHaveBeenCalled();
    expect(t.deploy).not.toHaveBeenCalled();
  });

  it("is refused when its public key was revoked (only active keys count)", async () => {
    const k = claimKey();
    const t = setup({ settings: withKey(k.seed) });
    vi.mocked(t.store.activeSigningKeys).mockResolvedValue([]);
    expect((await run(t.deps)).ok).toBe(false);
    expect(t.deploy).not.toHaveBeenCalled();
  });

  it.each([["too short"], ["!".repeat(43)], ["A".repeat(44)]])(
    "is refused when it is not a valid private key (%s)",
    async (seed) => {
      const t = setup({ settings: withKey(seed) });
      const out = await run(t.deps);
      expect(out.ok).toBe(false);
      expect(out.error).toContain("not a valid 43-character private key");
      expect(out.error).not.toContain(seed);
      expect(t.store.activeSigningKeys).not.toHaveBeenCalled();
      expect(t.deploy).not.toHaveBeenCalled();
    }
  );

  it("is not looked up at all when the school has no claim key", async () => {
    const t = setup();
    await run(t.deps);
    expect(t.store.activeSigningKeys).not.toHaveBeenCalled();
  });
});
