import { isPublicPath } from "@/lib/access";

// Cloudflare Access in front of the dashboard, checked a second time at the origin.
//
// Cloudflare signs in the person and forwards a short-lived RS256 token in the
// Cf-Access-Jwt-Assertion header. Checking it here means a request that reaches the
// server some other way (its address found, a misconfigured proxy rule) gets nothing,
// even before the app's own login. Cloudflare recommends the header over the
// CF_Authorization cookie, which is not guaranteed to be passed.
//
// Off unless CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD are both set. The machine
// endpoints in lib/access.ts (school servers, Paystack, the health cron) carry their
// own signature and cannot sign in to Access, so they are never asked for the token:
// give them a Bypass policy in Cloudflare (docs/cloudflare-access.md).
//
// Uses only Web Crypto, so it runs in Next's middleware.

export type AccessConfig = {
  /** https://<team>.cloudflareaccess.com, no trailing slash. */
  issuer: string;
  /** The application's Audience (AUD) tag. */
  audience: string;
};

/** Reads the two settings: both, or neither (null = Access is not enforced here). */
export function accessConfigFromEnv(
  source: Record<string, string | undefined> = process.env
): AccessConfig | null {
  const team = source.CF_ACCESS_TEAM_DOMAIN?.trim();
  const audience = source.CF_ACCESS_AUD?.trim();
  if (!team && !audience) return null;
  if (!team || !audience) {
    throw new Error("Set both CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD, or neither.");
  }
  const host = team.replace(/^https:\/\//, "").replace(/\/+$/, "");
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*\.cloudflareaccess\.com$/i.test(host)) {
    throw new Error("CF_ACCESS_TEAM_DOMAIN must look like your-team.cloudflareaccess.com.");
  }
  return { issuer: `https://${host.toLowerCase()}`, audience };
}

type Jwk = JsonWebKey & { kid?: string };
type Deps = {
  fetchImpl?: typeof fetch;
  now?: () => number;
};

const LEEWAY_S = 30;
const KEYS_TTL_MS = 60 * 60_000;
const REFETCH_MIN_MS = 60_000;
const FETCH_TIMEOUT_MS = 5_000;

const b64urlToBytes = (s: string): Uint8Array => {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};
const b64urlToJson = (s: string): unknown => JSON.parse(new TextDecoder().decode(b64urlToBytes(s)));

/** The signing keys for one team domain, cached, refreshed when a token names a new one. */
export class AccessKeys {
  private keys = new Map<string, Jwk>();
  private loadedAt = 0;
  private lastTry = 0;
  private inflight: Promise<void> | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(
    private readonly issuer: string,
    deps: Deps = {}
  ) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.now = deps.now ?? Date.now;
  }

  /** False until the keys have been read once. */
  hasAny(): boolean {
    return this.keys.size > 0;
  }

  async get(kid: string): Promise<Jwk | undefined> {
    const age = this.now() - this.loadedAt;
    if (this.keys.has(kid) && age < KEYS_TTL_MS) return this.keys.get(kid);
    // Unknown key (Cloudflare rotated) or stale list: read again, but not on every request,
    // so a flood of made-up kids cannot turn into a flood of requests to Cloudflare.
    if (this.now() - this.lastTry >= REFETCH_MIN_MS || this.keys.size === 0) {
      this.inflight ??= this.load().finally(() => {
        this.inflight = null;
      });
      await this.inflight.catch(() => {
        // Keep the keys we have; a key that is still unknown is refused below.
      });
    }
    return this.keys.get(kid);
  }

  private async load(): Promise<void> {
    this.lastTry = this.now();
    const res = await this.fetchImpl(`${this.issuer}/cdn-cgi/access/certs`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: "error",
    });
    if (!res.ok) throw new Error(`Cloudflare answered ${res.status} for the signing keys.`);
    const body = (await res.json()) as { keys?: Jwk[] };
    const next = new Map<string, Jwk>();
    for (const k of body.keys ?? []) if (k.kid && k.kty === "RSA") next.set(k.kid, k);
    if (next.size === 0) throw new Error("Cloudflare returned no signing keys.");
    this.keys = next;
    this.loadedAt = this.now();
  }
}

export type AccessResult = { ok: true; email?: string } | { ok: false; reason: string };

/** Checks one Access token: algorithm, signature, issuer, audience and time. */
export async function verifyAccessToken(
  token: string,
  config: AccessConfig,
  keys: AccessKeys,
  now: () => number = Date.now
): Promise<AccessResult> {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  let header: { alg?: unknown; kid?: unknown };
  let claims: { iss?: unknown; aud?: unknown; exp?: unknown; nbf?: unknown; email?: unknown };
  try {
    header = b64urlToJson(parts[0]) as typeof header;
    claims = b64urlToJson(parts[1]) as typeof claims;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  // Only RS256, whatever the token says: never "none", never a shared-secret algorithm.
  if (header.alg !== "RS256" || typeof header.kid !== "string") {
    return { ok: false, reason: "unsupported algorithm" };
  }

  const jwk = await keys.get(header.kid);
  if (!jwk) return { ok: false, reason: "unknown signing key" };
  let valid = false;
  try {
    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"]
    );
    valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      b64urlToBytes(parts[2]) as BufferSource,
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
    );
  } catch {
    return { ok: false, reason: "bad signature" };
  }
  if (!valid) return { ok: false, reason: "bad signature" };

  if (claims.iss !== config.issuer) return { ok: false, reason: "wrong issuer" };
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(config.audience)) return { ok: false, reason: "wrong application" };
  const nowS = Math.floor(now() / 1000);
  if (typeof claims.exp !== "number" || claims.exp + LEEWAY_S < nowS) {
    return { ok: false, reason: "expired" };
  }
  if (typeof claims.nbf === "number" && claims.nbf - LEEWAY_S > nowS) {
    return { ok: false, reason: "not yet valid" };
  }
  return { ok: true, email: typeof claims.email === "string" ? claims.email : undefined };
}

export type GateResult = { allow: true } | { allow: false; status: 403 | 503; message: string };

/**
 * The decision for one request. Public machine endpoints and an app with Access not
 * configured are let through; everything else needs a valid token. If the signing keys
 * cannot be read at all the answer is 503, not "allow": a check that cannot be made is
 * a refusal.
 */
export async function accessGate(
  input: { path: string; token: string | null },
  config: AccessConfig | null,
  keys: AccessKeys | null,
  now: () => number = Date.now
): Promise<GateResult> {
  if (!config || !keys || isPublicPath(input.path)) return { allow: true };
  if (!input.token) {
    return {
      allow: false,
      status: 403,
      message: "This address is only reachable through Cloudflare Access.",
    };
  }
  const result = await verifyAccessToken(input.token, config, keys, now);
  if (result.ok) return { allow: true };
  if (result.reason === "unknown signing key" && !keys.hasAny()) {
    return {
      allow: false,
      status: 503,
      message: "Access could not be checked right now. Try again shortly.",
    };
  }
  return {
    allow: false,
    status: 403,
    message: "This address is only reachable through Cloudflare Access.",
  };
}
