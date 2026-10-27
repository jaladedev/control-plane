import { z } from "zod";
import { timestampFresh, verifyClaim } from "@/lib/billing/claim-signature";

// The decision logic of POST /api/claims, separate from Next.js so every branch
// can be tested. Order matters: nothing is looked up, and nothing is revealed,
// until the request proves itself. Every authentication failure gets the SAME
// answer, so a caller cannot tell a wrong school, a wrong key, a stale timestamp
// and a missing key apart.

export const MAX_BODY_BYTES = 8 * 1024;

// Two fixed-window limits. The first runs before anything is looked up, per client
// address, so a flood of junk costs one counter update and nothing else; the
// address comes from a proxy header and is only good enough for that. The second
// runs once the signature has proved the school, so one school cannot hammer the
// queue even with a valid key. A real school sends a claim a few times a year.
export const CLAIM_LIMITS = {
  perAddress: { windowSeconds: 60, max: 30 },
  perSchool: { windowSeconds: 600, max: 10 },
} as const;

export const claimBodySchema = z
  .object({
    subscription_reference: z
      .string()
      .regex(/^SUB-[0-9A-F]{8}$/, "That is not an invoice reference."),
    client_ref: z.string().min(8, "client_ref is too short.").max(80),
    amount_kobo: z.number().int().positive().max(1_000_000_000_000),
    sent_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "sent_on must be a date like 2026-10-25."),
    sender_name: z.string().trim().min(1).max(120),
    payer_reference: z.string().trim().max(120).optional(),
    proof_path: z.string().max(300).optional(),
    claimed_by: z.string().trim().min(1).max(120),
  })
  .strict();

export type ClaimBody = z.infer<typeof claimBodySchema>;

export type ClaimDeps = {
  findSchool(slug: string): Promise<{ id: string; status: string } | null>;
  publicKeys(schoolId: string): Promise<string[]>;
  /** Writes the audit row first; throws if it cannot. */
  audit(action: string, schoolId: string, details: Record<string, unknown>): Promise<void>;
  /** Counts one hit on a bucket; false means over the limit. */
  rateLimit(bucket: string, windowSeconds: number, max: number): Promise<boolean>;
  /** Calls submit_claim. `businessError` is a message the school may be shown. */
  submit(
    schoolId: string,
    body: ClaimBody
  ): Promise<{ claimId: string } | { businessError: string }>;
};

export type ClaimResult = {
  status: number;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
};

const tooMany = (windowSeconds: number): ClaimResult => ({
  status: 429,
  body: { ok: false, error: "Too many requests. Wait a little and try again." },
  headers: { "retry-after": String(windowSeconds) },
});

// A broken limiter must not stop a school from paying, so it fails open: the
// signature, not the limit, is what keeps strangers out.
async function withinLimit(
  deps: ClaimDeps,
  bucket: string,
  limit: { windowSeconds: number; max: number }
): Promise<boolean> {
  try {
    return await deps.rateLimit(bucket, limit.windowSeconds, limit.max);
  } catch {
    return true;
  }
}

const REJECTED: ClaimResult = { status: 401, body: { ok: false, error: "Request rejected." } };

export async function handleClaim(
  req: {
    slug: string | null;
    timestamp: string | null;
    signature: string | null;
    rawBody: string;
    /** The caller's address as the proxy reported it, or null. */
    ip?: string | null;
  },
  deps: ClaimDeps,
  now: Date = new Date()
): Promise<ClaimResult> {
  if (Buffer.byteLength(req.rawBody) > MAX_BODY_BYTES) {
    return { status: 413, body: { ok: false, error: "The request is too large." } };
  }
  const address = (req.ip ?? "").trim().slice(0, 64) || "unknown";
  if (!(await withinLimit(deps, `claim:ip:${address}`, CLAIM_LIMITS.perAddress))) {
    return tooMany(CLAIM_LIMITS.perAddress.windowSeconds);
  }
  const slug = req.slug ?? "";
  const timestamp =
    req.timestamp !== null && /^\d{1,12}$/.test(req.timestamp) ? Number(req.timestamp) : NaN;
  if (
    !/^[a-z0-9][a-z0-9-]{0,40}$/.test(slug) ||
    !req.signature ||
    !timestampFresh(timestamp, now)
  ) {
    return REJECTED;
  }

  const school = await deps.findSchool(slug);
  if (!school) return REJECTED;
  const keys = await deps.publicKeys(school.id);
  if (keys.length === 0) return REJECTED;
  if (
    !verifyClaim({ publicKeys: keys, slug, timestamp, body: req.rawBody, signature: req.signature })
  ) {
    return REJECTED;
  }

  // Authenticated from here on, so specific answers are fine.
  if (!(await withinLimit(deps, `claim:school:${school.id}`, CLAIM_LIMITS.perSchool))) {
    return tooMany(CLAIM_LIMITS.perSchool.windowSeconds);
  }
  if (school.status === "archived") {
    return { status: 403, body: { ok: false, error: "This school is archived." } };
  }
  let json: unknown;
  try {
    json = JSON.parse(req.rawBody);
  } catch {
    return { status: 400, body: { ok: false, error: "The body is not valid JSON." } };
  }
  const parsed = claimBodySchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue.path.length ? `${issue.path.join(".")}: ` : "";
    return { status: 400, body: { ok: false, error: `${where}${issue.message}` } };
  }

  await deps.audit("claim.submit", school.id, {
    reference: parsed.data.subscription_reference,
    client_ref: parsed.data.client_ref,
    amount_kobo: parsed.data.amount_kobo,
  });
  const result = await deps.submit(school.id, parsed.data);
  if ("businessError" in result) {
    return { status: 409, body: { ok: false, error: result.businessError } };
  }
  return { status: 201, body: { ok: true, claim_id: result.claimId } };
}
