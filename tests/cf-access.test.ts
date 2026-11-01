import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  AccessKeys,
  accessConfigFromEnv,
  accessGate,
  verifyAccessToken,
  type AccessConfig,
} from "@/lib/cf-access";

const ISSUER = "https://acme.cloudflareaccess.com";
const AUD = "4714c1358e65fe4b408ad6d432a5f878f08194bdb4752441fd56faefa9b2b6f2";
const config: AccessConfig = { issuer: ISSUER, audience: AUD };
const NOW = 1_800_000_000_000;

const b64url = (b: Uint8Array | string) =>
  Buffer.from(typeof b === "string" ? b : b).toString("base64url");

type Pair = { kid: string; jwk: JsonWebKey; privateKey: CryptoKey };
async function makeKey(kid: string): Promise<Pair> {
  const { publicKey, privateKey } = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"]
  );
  return { kid, jwk: await crypto.subtle.exportKey("jwk", publicKey), privateKey };
}

async function sign(
  pair: Pair,
  claims: Record<string, unknown> = {},
  header: Record<string, unknown> = {}
): Promise<string> {
  const h = b64url(JSON.stringify({ alg: "RS256", kid: pair.kid, typ: "JWT", ...header }));
  const p = b64url(
    JSON.stringify({
      iss: ISSUER,
      aud: [AUD],
      email: "ayo@example.com",
      iat: NOW / 1000 - 60,
      exp: NOW / 1000 + 600,
      ...claims,
    })
  );
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    pair.privateKey,
    new TextEncoder().encode(`${h}.${p}`)
  );
  return `${h}.${p}.${b64url(new Uint8Array(sig))}`;
}

let current: Pair;
let previous: Pair;
let stranger: Pair;
beforeAll(async () => {
  current = await makeKey("kid-current");
  previous = await makeKey("kid-previous");
  stranger = await makeKey("kid-current"); // same name as ours, different key
});

function setup(served: () => Pair[] = () => [current, previous]) {
  let clock = NOW;
  const fetchImpl = vi.fn(
    async (..._args: unknown[]) =>
      new Response(
        JSON.stringify({
          keys: served().map((k) => ({ ...k.jwk, kid: k.kid, use: "sig", alg: "RS256" })),
        }),
        { status: 200 }
      )
  );
  const keys = new AccessKeys(ISSUER, {
    fetchImpl: fetchImpl as unknown as typeof fetch,
    now: () => clock,
  });
  return { keys, fetchImpl, now: () => clock, tick: (ms: number) => (clock += ms) };
}

describe("accessConfigFromEnv", () => {
  it("is off when neither setting is set", () => {
    expect(accessConfigFromEnv({})).toBeNull();
    expect(accessConfigFromEnv({ CF_ACCESS_TEAM_DOMAIN: " ", CF_ACCESS_AUD: "" })).toBeNull();
  });
  it("takes the team domain with or without https://", () => {
    for (const team of [
      "acme.cloudflareaccess.com",
      "https://acme.cloudflareaccess.com/",
      "ACME.cloudflareaccess.com",
    ]) {
      expect(accessConfigFromEnv({ CF_ACCESS_TEAM_DOMAIN: team, CF_ACCESS_AUD: AUD })).toEqual(
        config
      );
    }
  });
  it("wants both settings, or neither", () => {
    expect(() => accessConfigFromEnv({ CF_ACCESS_AUD: AUD })).toThrow(
      /both CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD/
    );
    expect(() =>
      accessConfigFromEnv({ CF_ACCESS_TEAM_DOMAIN: "acme.cloudflareaccess.com" })
    ).toThrow(/both/);
  });
  it("only accepts a cloudflareaccess.com team domain, so the keys cannot come from elsewhere", () => {
    for (const bad of [
      "evil.example.com",
      "acme.cloudflareaccess.com.evil.com",
      "http://acme.cloudflareaccess.com",
      "acme",
    ]) {
      expect(
        () => accessConfigFromEnv({ CF_ACCESS_TEAM_DOMAIN: bad, CF_ACCESS_AUD: AUD }),
        bad
      ).toThrow(/must look like/);
    }
  });
});

describe("verifyAccessToken", () => {
  it("accepts a token signed by Cloudflare for this application, and reads the email", async () => {
    const { keys, now } = setup();
    expect(await verifyAccessToken(await sign(current), config, keys, now)).toEqual({
      ok: true,
      email: "ayo@example.com",
    });
  });

  it("accepts the previous key too, which Cloudflare keeps for a while after rotating", async () => {
    const { keys, now } = setup();
    expect((await verifyAccessToken(await sign(previous), config, keys, now)).ok).toBe(true);
  });

  it("accepts a single audience given as a string", async () => {
    const { keys, now } = setup();
    expect((await verifyAccessToken(await sign(current, { aud: AUD }), config, keys, now)).ok).toBe(
      true
    );
  });

  it.each([
    ["another application's audience", { aud: ["someone-elses-tag"] }, "wrong application"],
    ["no audience", { aud: undefined }, "wrong application"],
    ["another team's issuer", { iss: "https://other.cloudflareaccess.com" }, "wrong issuer"],
    ["an expired token", { exp: NOW / 1000 - 120 }, "expired"],
    ["no expiry", { exp: undefined }, "expired"],
    ["a token not valid yet", { nbf: NOW / 1000 + 3600 }, "not yet valid"],
  ])("refuses %s", async (_name, claims, reason) => {
    const { keys, now } = setup();
    expect(await verifyAccessToken(await sign(current, claims), config, keys, now)).toEqual({
      ok: false,
      reason,
    });
  });

  it("allows a few seconds of clock difference", async () => {
    const { keys, now } = setup();
    expect(
      (await verifyAccessToken(await sign(current, { exp: NOW / 1000 - 10 }), config, keys, now)).ok
    ).toBe(true);
  });

  it("refuses a token signed with someone else's key, even under our key's name", async () => {
    const { keys, now } = setup();
    expect(await verifyAccessToken(await sign(stranger), config, keys, now)).toEqual({
      ok: false,
      reason: "bad signature",
    });
  });

  it("refuses a token whose body was changed after signing", async () => {
    const { keys, now } = setup();
    const [h, , s] = (await sign(current)).split(".");
    const forged = b64url(
      JSON.stringify({ iss: ISSUER, aud: [AUD], email: "boss@example.com", exp: NOW / 1000 + 600 })
    );
    expect(await verifyAccessToken(`${h}.${forged}.${s}`, config, keys, now)).toEqual({
      ok: false,
      reason: "bad signature",
    });
  });

  it.each(["none", "HS256", "RS512", "rs256"])(
    "refuses the algorithm %s whatever the rest says",
    async (alg) => {
      const { keys, now } = setup();
      expect(await verifyAccessToken(await sign(current, {}, { alg }), config, keys, now)).toEqual({
        ok: false,
        reason: "unsupported algorithm",
      });
    }
  );

  it("refuses a token with no key name", async () => {
    const { keys, now } = setup();
    expect(
      (await verifyAccessToken(await sign(current, {}, { kid: undefined }), config, keys, now)).ok
    ).toBe(false);
  });

  it.each(["", "abc", "a.b", "a.b.c.d", "!!.@@.##"])(
    "refuses the malformed token %j",
    async (token) => {
      const { keys, now } = setup();
      expect((await verifyAccessToken(token, config, keys, now)).ok).toBe(false);
    }
  );

  it("refuses a key name Cloudflare does not publish", async () => {
    const { keys, now } = setup();
    const ghost = await makeKey("kid-ghost");
    expect(await verifyAccessToken(await sign(ghost), config, keys, now)).toEqual({
      ok: false,
      reason: "unknown signing key",
    });
  });
});

describe("AccessKeys", () => {
  it("reads the keys once and reuses them", async () => {
    const { keys, fetchImpl, now } = setup();
    await verifyAccessToken(await sign(current), config, keys, now);
    await verifyAccessToken(await sign(previous), config, keys, now);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0][0])).toBe(`${ISSUER}/cdn-cgi/access/certs`);
  });

  it("follows a rotation: a new key name triggers one new read", async () => {
    let served = [current];
    const { keys, fetchImpl, now, tick } = setup(() => served);
    expect((await verifyAccessToken(await sign(current), config, keys, now)).ok).toBe(true);
    const next = await makeKey("kid-next");
    served = [next, current];
    tick(61_000);
    expect((await verifyAccessToken(await sign(next), config, keys, now)).ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not hammer Cloudflare when tokens keep naming keys it does not publish", async () => {
    const { keys, fetchImpl, now } = setup();
    await verifyAccessToken(await sign(current), config, keys, now);
    const ghost = await makeKey("kid-ghost");
    for (let i = 0; i < 20; i++) await verifyAccessToken(await sign(ghost), config, keys, now);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("refreshes after an hour even when the key name is known", async () => {
    const { keys, fetchImpl, now, tick } = setup();
    await verifyAccessToken(await sign(current), config, keys, now);
    tick(61 * 60_000);
    await verifyAccessToken(await sign(current, { exp: NOW / 1000 + 7200 }), config, keys, now);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("keeps using the keys it has when Cloudflare cannot be reached", async () => {
    let down = false;
    const base = setup();
    const flaky = vi.fn(async (..._args: unknown[]) => {
      if (down) throw new Error("network");
      return base.fetchImpl();
    });
    const keys = new AccessKeys(ISSUER, {
      fetchImpl: flaky as unknown as typeof fetch,
      now: base.now,
    });
    await verifyAccessToken(await sign(current), config, keys, base.now);
    down = true;
    base.tick(61 * 60_000);
    expect(
      (
        await verifyAccessToken(
          await sign(current, { exp: NOW / 1000 + 7200 }),
          config,
          keys,
          base.now
        )
      ).ok
    ).toBe(true);
  });
});

describe("accessGate", () => {
  const run = async (
    path: string,
    token: string | null,
    cfg: AccessConfig | null,
    keys: AccessKeys | null,
    now?: () => number
  ) => accessGate({ path, token }, cfg, keys, now);

  it("lets everything through when Access is not configured", async () => {
    expect(await run("/", null, null, null)).toEqual({ allow: true });
  });

  it("lets a valid token through to any page", async () => {
    const { keys, now } = setup();
    expect(await run("/billing", await sign(current), config, keys, now)).toEqual({ allow: true });
  });

  it("answers 403 to a request with no token or a bad one, and says nothing about why", async () => {
    const { keys, now } = setup();
    for (const token of [null, "garbage", await sign(current, { aud: ["x"] })]) {
      expect(await run("/", token, config, keys, now)).toEqual({
        allow: false,
        status: 403,
        message: "This address is only reachable through Cloudflare Access.",
      });
    }
  });

  it("never asks the machine endpoints for a token: they check their own signature", async () => {
    const { keys, now } = setup();
    for (const path of [
      "/api/claims",
      "/api/claims/proof",
      "/api/invoices",
      "/api/receipts",
      "/api/receipts/pdf",
      "/api/paystack/checkout",
      "/api/paystack/webhook",
      "/api/cron/health",
      "/api/health",
    ]) {
      expect(await run(path, null, config, keys, now), path).toEqual({ allow: true });
    }
  });

  it("does not treat a look-alike path as public", async () => {
    const { keys, now } = setup();
    for (const path of ["/api/claims/", "/api/claims/other", "/api/health/x", "/api/cron"]) {
      expect((await run(path, null, config, keys, now)).allow, path).toBe(false);
    }
  });

  it("answers 503, not allow, when the keys cannot be read at all", async () => {
    const fetchImpl = vi.fn(async () => new Response("no", { status: 500 }));
    const keys = new AccessKeys(ISSUER, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW,
    });
    expect(await run("/", await sign(current), config, keys, () => NOW)).toEqual({
      allow: false,
      status: 503,
      message: "Access could not be checked right now. Try again shortly.",
    });
  });
});
