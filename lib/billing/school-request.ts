import type { z } from "zod";
import { timestampFresh, verifyClaim, type SignaturePurpose } from "@/lib/billing/claim-signature";

// What every signed request from a school has in common: the order of checks, and
// the one answer given to every authentication failure. Nothing is looked up, and
// nothing is revealed, until the request proves itself, so a caller cannot tell a
// wrong school, a wrong key, a stale timestamp and a missing key apart.

export const MAX_BODY_BYTES = 8 * 1024;

export type RequestResult = {
  status: number;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
};

export type SchoolRequest = {
  slug: string | null;
  timestamp: string | null;
  signature: string | null;
  rawBody: string;
  /** The caller's address as the proxy reported it, or null. */
  ip?: string | null;
};

export type SchoolAuthDeps = {
  findSchool(slug: string): Promise<{ id: string; status: string } | null>;
  publicKeys(schoolId: string): Promise<string[]>;
  /** Counts one hit on a bucket; false means over the limit. */
  rateLimit(bucket: string, windowSeconds: number, max: number): Promise<boolean>;
};

export type Limit = { windowSeconds: number; max: number };

export const REJECTED: RequestResult = {
  status: 401,
  body: { ok: false, error: "Request rejected." },
};

export const tooMany = (windowSeconds: number): RequestResult => ({
  status: 429,
  body: { ok: false, error: "Too many requests. Wait a little and try again." },
  headers: { "retry-after": String(windowSeconds) },
});

// A broken limiter must not stop a school from paying, so it fails open: the
// signature, not the limit, is what keeps strangers out.
async function withinLimit(deps: SchoolAuthDeps, bucket: string, limit: Limit): Promise<boolean> {
  try {
    return await deps.rateLimit(bucket, limit.windowSeconds, limit.max);
  } catch {
    return true;
  }
}

export type Authenticated =
  | { ok: true; school: { id: string; slug: string; status: string } }
  | { ok: false; result: RequestResult };

/**
 * Size, per-address limit, signature, per-school limit and archived check, in that
 * order. `bucket` names the counters ("claim" gives claim:ip:<address> and
 * claim:school:<id>), so each kind of request spends its own allowance.
 */
export async function authenticateSchoolRequest(
  req: SchoolRequest,
  deps: SchoolAuthDeps,
  opts: {
    purpose: SignaturePurpose;
    bucket: string;
    perAddress: Limit;
    perSchool: Limit;
  },
  now: Date
): Promise<Authenticated> {
  if (Buffer.byteLength(req.rawBody) > MAX_BODY_BYTES) {
    return {
      ok: false,
      result: { status: 413, body: { ok: false, error: "The request is too large." } },
    };
  }
  const address = (req.ip ?? "").trim().slice(0, 64) || "unknown";
  if (!(await withinLimit(deps, `${opts.bucket}:ip:${address}`, opts.perAddress))) {
    return { ok: false, result: tooMany(opts.perAddress.windowSeconds) };
  }
  const slug = req.slug ?? "";
  const timestamp =
    req.timestamp !== null && /^\d{1,12}$/.test(req.timestamp) ? Number(req.timestamp) : NaN;
  if (
    !/^[a-z0-9][a-z0-9-]{0,40}$/.test(slug) ||
    !req.signature ||
    !timestampFresh(timestamp, now)
  ) {
    return { ok: false, result: REJECTED };
  }
  const school = await deps.findSchool(slug);
  if (!school) return { ok: false, result: REJECTED };
  const keys = await deps.publicKeys(school.id);
  if (keys.length === 0) return { ok: false, result: REJECTED };
  if (
    !verifyClaim({
      publicKeys: keys,
      slug,
      timestamp,
      body: req.rawBody,
      signature: req.signature,
      purpose: opts.purpose,
    })
  ) {
    return { ok: false, result: REJECTED };
  }

  // Authenticated from here on, so specific answers are fine.
  if (!(await withinLimit(deps, `${opts.bucket}:school:${school.id}`, opts.perSchool))) {
    return { ok: false, result: tooMany(opts.perSchool.windowSeconds) };
  }
  if (school.status === "archived") {
    return {
      ok: false,
      result: { status: 403, body: { ok: false, error: "This school is archived." } },
    };
  }
  return { ok: true, school: { id: school.id, slug, status: school.status } };
}

/** Parses and checks a body, answering 400 in words the school can read. */
export function parseBody<S extends z.ZodTypeAny>(
  rawBody: string,
  schema: S
): { ok: true; data: z.infer<S> } | { ok: false; result: RequestResult } {
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return {
      ok: false,
      result: { status: 400, body: { ok: false, error: "The body is not valid JSON." } },
    };
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue.path.length ? `${issue.path.join(".")}: ` : "";
    return {
      ok: false,
      result: { status: 400, body: { ok: false, error: `${where}${issue.message}` } },
    };
  }
  return { ok: true, data: parsed.data };
}
