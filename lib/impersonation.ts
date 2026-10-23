import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

// Signed, single-use links that open a read-only support session on one
// school. The hosting control plane signs the link with that school's own
// IMPERSONATION_SIGNING_SECRET (set in the school's env file); the school's container
// verifies it. This module is the shared definition of the format, kept free
// of app dependencies so the control plane can use the same code.
//
// Token: base64url(JSON claims) + "." + base64url(HMAC-SHA256 of that part).
// Claims:
//   v    format version (1)
//   sch  the school slug the link is for; refused if it is not this school's
//   by   who asked for it (a control-plane user id or email); stored in the
//        audit log with every page the session views
//   jti  unique id; the school records it when used so a link works only once
//   iat  issued at, exp expiry (unix seconds). Links live for at most 10 minutes.

export const MAX_LINK_LIFETIME_SECONDS = 10 * 60;

export type ImpersonationClaims = {
  v: 1;
  sch: string;
  by: string;
  jti: string;
  iat: number;
  exp: number;
};

export type VerifyResult =
  | { ok: true; claims: ImpersonationClaims }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" | "wrong_school" | "too_long" };

function sign(secret: string, body: string): Buffer {
  return createHmac("sha256", secret).update(body).digest();
}

export function signImpersonationToken(params: {
  secret: string;
  school: string;
  by: string;
  ttlSeconds?: number;
  now?: Date;
  jti?: string;
}): string {
  const now = Math.floor((params.now ?? new Date()).getTime() / 1000);
  const ttl = Math.min(params.ttlSeconds ?? 5 * 60, MAX_LINK_LIFETIME_SECONDS);
  const claims: ImpersonationClaims = {
    v: 1,
    sch: params.school,
    by: params.by,
    jti: params.jti ?? randomUUID(),
    iat: now,
    exp: now + ttl,
  };
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${body}.${sign(params.secret, body).toString("base64url")}`;
}

export function verifyImpersonationToken(
  token: string,
  params: { secret: string; school: string; now?: Date }
): VerifyResult {
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: "malformed" };
  const [body, signature] = parts;

  // Check the signature before reading anything else in the token.
  const expected = sign(params.secret, body);
  const given = Buffer.from(signature, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { ok: false, reason: "bad_signature" };
  }

  let claims: ImpersonationClaims;
  try {
    claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (
    claims?.v !== 1 ||
    typeof claims.sch !== "string" ||
    typeof claims.by !== "string" ||
    !claims.by ||
    typeof claims.jti !== "string" ||
    !claims.jti ||
    !Number.isInteger(claims.iat) ||
    !Number.isInteger(claims.exp)
  ) {
    return { ok: false, reason: "malformed" };
  }

  if (claims.sch !== params.school) return { ok: false, reason: "wrong_school" };
  if (claims.exp - claims.iat > MAX_LINK_LIFETIME_SECONDS) return { ok: false, reason: "too_long" };

  const now = Math.floor((params.now ?? new Date()).getTime() / 1000);
  if (now >= claims.exp || now < claims.iat - 60) return { ok: false, reason: "expired" };

  return { ok: true, claims };
}
