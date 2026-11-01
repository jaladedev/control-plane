import { describe, expect, it, vi } from "vitest";
import { InfisicalSecrets, type InfisicalConfig } from "@/worker/infisical";

const DB = "postgresql://postgres:s3cretPassw0rd@db.abc.supabase.co:5432/postgres";
const SERVICE_KEY = "service-role-key-value-1";

type Row = { secretKey: string; secretValue: string; secretPath?: string };
const rows = (over: Row[] = []): Row[] => [
  { secretKey: "DATABASE_URL", secretValue: DB, secretPath: "/schools/greenfield" },
  {
    secretKey: "SUPABASE_URL",
    secretValue: "https://abc.supabase.co",
    secretPath: "/schools/greenfield",
  },
  {
    secretKey: "SUPABASE_SERVICE_ROLE_KEY",
    secretValue: SERVICE_KEY,
    secretPath: "/schools/greenfield",
  },
  {
    secretKey: "DATABASE_URL",
    secretValue: "postgresql://postgres:otherSchoolPw1@db.xyz.supabase.co:5432/postgres",
    secretPath: "/schools/hillcrest",
  },
  ...over,
];

function setup(
  opts: { secrets?: () => Row[]; expiresIn?: number; cfg?: Partial<InfisicalConfig> } = {}
) {
  let clock = 1_000_000;
  const calls: { url: URL; init: RequestInit }[] = [];
  const fetchImpl = vi.fn(async (url: URL | string, init: RequestInit = {}) => {
    const u = new URL(String(url));
    calls.push({ url: u, init });
    if (u.pathname === "/api/v1/auth/universal-auth/login") {
      return new Response(
        JSON.stringify({
          accessToken: `tok-${calls.length}`,
          expiresIn: opts.expiresIn ?? 7200,
          tokenType: "Bearer",
          accessTokenMaxTTL: 43200,
        }),
        { status: 200 }
      );
    }
    return new Response(JSON.stringify({ secrets: (opts.secrets ?? rows)() }), { status: 200 });
  });
  const cfg: InfisicalConfig = {
    baseUrl: "https://infisical.example.com",
    clientId: "cid",
    clientSecret: "csecret",
    projectId: "proj-1",
    environment: "prod",
    basePath: "/schools",
    cacheMs: 60_000,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    now: () => clock,
    ...opts.cfg,
  };
  return { cfg, fetchImpl, calls, tick: (ms: number) => (clock += ms) };
}

describe("InfisicalSecrets", () => {
  it("signs in with Universal Auth, then reads every school's folder in one request", async () => {
    const { cfg, calls } = setup();
    await InfisicalSecrets.create(cfg);
    expect(calls).toHaveLength(2);
    expect(calls[0].url.pathname).toBe("/api/v1/auth/universal-auth/login");
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      clientId: "cid",
      clientSecret: "csecret",
    });
    expect(calls[1].url.pathname).toBe("/api/v4/secrets");
    expect(Object.fromEntries(calls[1].url.searchParams)).toMatchObject({
      projectId: "proj-1",
      environment: "prod",
      secretPath: "/schools",
      recursive: "true",
    });
    expect((calls[1].init.headers as Record<string, string>).authorization).toBe("Bearer tok-1");
  });

  it("gives each school its database URL and its container settings, kept apart", async () => {
    const s = await InfisicalSecrets.create(setup().cfg);
    expect(await s.schoolDatabaseUrl("greenfield")).toBe(DB);
    expect(await s.schoolAppEnv("greenfield")).toEqual({
      SUPABASE_URL: "https://abc.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
    });
    expect(await s.schoolAppEnv("hillcrest")).toBeUndefined();
    await expect(s.schoolDatabaseUrl("nowhere")).rejects.toThrow(/No database URL for "nowhere"/);
  });

  it("returns a copy of the settings, so a caller cannot change what is cached", async () => {
    const s = await InfisicalSecrets.create(setup().cfg);
    (await s.schoolAppEnv("greenfield"))!.SUPABASE_URL = "changed";
    expect((await s.schoolAppEnv("greenfield"))!.SUPABASE_URL).toBe("https://abc.supabase.co");
  });

  it("ignores secrets that are not directly in a school's folder", async () => {
    const s = await InfisicalSecrets.create(
      setup({
        secrets: () =>
          rows([
            { secretKey: "STRAY", secretValue: "stray-value-123", secretPath: "/schools" },
            {
              secretKey: "DEEP",
              secretValue: "deep-value-1234",
              secretPath: "/schools/greenfield/old",
            },
            {
              secretKey: "ELSEWHERE",
              secretValue: "else-value-1234",
              secretPath: "/other/greenfield",
            },
            { secretKey: "BAD", secretValue: "bad-value-12345", secretPath: "/schools/Bad Slug" },
          ]),
      }).cfg
    );
    expect(Object.keys((await s.schoolAppEnv("greenfield"))!)).toEqual([
      "SUPABASE_URL",
      "SUPABASE_SERVICE_ROLE_KEY",
    ]);
  });

  it("refuses the whole read when a secret does not say which folder it is in", async () => {
    const { cfg } = setup({
      secrets: () => rows([{ secretKey: "X", secretValue: "x-value-12345" }]),
    });
    await expect(InfisicalSecrets.create(cfg)).rejects.toThrow(/did not say which folder/);
  });

  it("reads from the cache until it is old, then reads again without signing in again", async () => {
    const { cfg, calls, tick } = setup();
    const s = await InfisicalSecrets.create(cfg);
    await s.schoolDatabaseUrl("greenfield");
    tick(59_000);
    await s.schoolDatabaseUrl("greenfield");
    expect(calls).toHaveLength(2);
    tick(2_000);
    await s.schoolDatabaseUrl("greenfield");
    expect(calls).toHaveLength(3);
    expect(calls[2].url.pathname).toBe("/api/v4/secrets");
  });

  it("picks up a rotated secret without a restart", async () => {
    let url = DB;
    const { cfg, tick } = setup({
      secrets: () =>
        rows().map((r) =>
          r.secretKey === "DATABASE_URL" && r.secretPath === "/schools/greenfield"
            ? { ...r, secretValue: url }
            : r
        ),
    });
    const s = await InfisicalSecrets.create(cfg);
    url = "postgresql://postgres:brandNewPw99@db.abc.supabase.co:5432/postgres";
    tick(61_000);
    expect(await s.schoolDatabaseUrl("greenfield")).toBe(url);
  });

  it("signs in again when the access token is about to end", async () => {
    const { cfg, calls, tick } = setup({ expiresIn: 100 });
    const s = await InfisicalSecrets.create(cfg);
    tick(75_000);
    await s.schoolDatabaseUrl("greenfield");
    expect(calls.map((c) => c.url.pathname)).toEqual([
      "/api/v1/auth/universal-auth/login",
      "/api/v4/secrets",
      "/api/v1/auth/universal-auth/login",
      "/api/v4/secrets",
    ]);
  });

  it("shares one read between callers that arrive together", async () => {
    const { cfg, calls, tick } = setup();
    const s = await InfisicalSecrets.create(cfg);
    tick(61_000);
    await Promise.all([
      s.schoolDatabaseUrl("greenfield"),
      s.schoolAppEnv("greenfield"),
      s.schoolDatabaseUrl("hillcrest"),
    ]);
    expect(calls).toHaveLength(3);
  });

  describe("when Infisical cannot be read", () => {
    it("stops the worker at start-up, naming the problem and no secret", async () => {
      const fetchImpl = vi.fn(async () => new Response("{}", { status: 401 }));
      const err = await InfisicalSecrets.create({
        ...setup().cfg,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }).catch((e: Error) => e);
      expect((err as Error).message).toMatch(/answered 401 when signing in.*client ID and secret/);
      expect((err as Error).message).not.toContain("csecret");
    });

    it("keeps using the last good read for a while, then stops", async () => {
      let down = false;
      const base = setup();
      const flaky = vi.fn(async (url: URL | string, init?: RequestInit) => {
        if (down && new URL(String(url)).pathname === "/api/v4/secrets")
          return new Response("{}", { status: 503 });
        return base.fetchImpl(url, init);
      });
      const s = await InfisicalSecrets.create({
        ...base.cfg,
        fetchImpl: flaky as unknown as typeof fetch,
        maxStaleMs: 10 * 60_000,
      });
      down = true;
      base.tick(61_000);
      expect(await s.schoolDatabaseUrl("greenfield")).toBe(DB);
      base.tick(10 * 60_000);
      await expect(s.schoolDatabaseUrl("greenfield")).rejects.toThrow(
        /answered 503 when reading secrets/
      );
    });

    it("says it could not be reached, not why the network failed", async () => {
      const fetchImpl = vi.fn(async () => {
        throw new Error("getaddrinfo ENOTFOUND infisical.example.com?token=abc");
      });
      const err = await InfisicalSecrets.create({
        ...setup().cfg,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }).catch((e: Error) => e);
      expect((err as Error).message).toBe("Infisical could not be reached.");
    });

    it("rejects an answer of the wrong shape", async () => {
      const fetchImpl = vi.fn(
        async () => new Response(JSON.stringify({ nope: 1 }), { status: 200 })
      );
      await expect(
        InfisicalSecrets.create({ ...setup().cfg, fetchImpl: fetchImpl as unknown as typeof fetch })
      ).rejects.toThrow(/something unexpected/);
    });
  });

  it("only talks plain http to a server on this machine", async () => {
    await expect(
      InfisicalSecrets.create({ ...setup().cfg, baseUrl: "http://infisical.example.com" })
    ).rejects.toThrow(/must be https/);
    await expect(
      InfisicalSecrets.create({ ...setup().cfg, baseUrl: "http://localhost:8080" })
    ).resolves.toBeDefined();
  });

  describe("redact", () => {
    it("scrubs database URLs, their passwords and every container setting from every school", async () => {
      const s = await InfisicalSecrets.create(setup().cfg);
      expect(s.redact(`connect failed for ${DB}`)).toBe("connect failed for [database url]");
      expect(s.redact("password s3cretPassw0rd was wrong")).not.toContain("s3cretPassw0rd");
      expect(s.redact("otherSchoolPw1 leaked")).toContain("[secret]");
      expect(s.redact(`key ${SERVICE_KEY} used`)).toBe("key [secret] used");
      expect(s.redact("relation x does not exist")).toBe("relation x does not exist");
    });

    it("still scrubs a value that has since been rotated away", async () => {
      let key = SERVICE_KEY;
      const { cfg, tick } = setup({
        secrets: () =>
          rows().map((r) =>
            r.secretKey === "SUPABASE_SERVICE_ROLE_KEY" ? { ...r, secretValue: key } : r
          ),
      });
      const s = await InfisicalSecrets.create(cfg);
      key = "rotated-service-key-2";
      tick(61_000);
      await s.schoolAppEnv("greenfield");
      expect(s.redact(`old ${SERVICE_KEY}, new ${key}`)).toBe("old [secret], new [secret]");
    });
  });
});
