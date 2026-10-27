import { z } from "zod";
import { timestampFresh, verifyClaim } from "@/lib/billing/claim-signature";

// The decision logic of POST /api/claims, separate from Next.js so every branch
// can be tested. Order matters: nothing is looked up, and nothing is revealed,
// until the request proves itself. Every authentication failure gets the SAME
// answer, so a caller cannot tell a wrong school, a wrong key, a stale timestamp
// and a missing key apart.

export const MAX_BODY_BYTES = 8 * 1024;

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
  /** Calls submit_claim. `businessError` is a message the school may be shown. */
  submit(
    schoolId: string,
    body: ClaimBody
  ): Promise<{ claimId: string } | { businessError: string }>;
};

export type ClaimResult = { status: number; body: Record<string, unknown> };

const REJECTED: ClaimResult = { status: 401, body: { ok: false, error: "Request rejected." } };

export async function handleClaim(
  req: { slug: string | null; timestamp: string | null; signature: string | null; rawBody: string },
  deps: ClaimDeps,
  now: Date = new Date()
): Promise<ClaimResult> {
  if (Buffer.byteLength(req.rawBody) > MAX_BODY_BYTES) {
    return { status: 413, body: { ok: false, error: "The request is too large." } };
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
