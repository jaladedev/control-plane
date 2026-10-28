import { z } from "zod";
import {
  MAX_BODY_BYTES,
  authenticateSchoolRequest,
  parseBody,
  type RequestResult,
  type SchoolAuthDeps,
  type SchoolRequest,
} from "@/lib/billing/school-request";
import { isProofPathFor } from "@/lib/storage/proofs";

// The decision logic of POST /api/claims, separate from Next.js so every branch
// can be tested. The checks every signed school request shares (size, limits,
// signature, archived) live in school-request.ts; this adds the claim itself.

export { MAX_BODY_BYTES };

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

export type ClaimDeps = SchoolAuthDeps & {
  /** Writes the audit row first; throws if it cannot. */
  audit(action: string, schoolId: string, details: Record<string, unknown>): Promise<void>;
  /** Calls submit_claim. `businessError` is a message the school may be shown. */
  submit(
    schoolId: string,
    body: ClaimBody
  ): Promise<{ claimId: string } | { businessError: string }>;
};

export type ClaimResult = RequestResult;

export async function handleClaim(
  req: SchoolRequest,
  deps: ClaimDeps,
  now: Date = new Date()
): Promise<ClaimResult> {
  const auth = await authenticateSchoolRequest(
    req,
    deps,
    { purpose: "claim-v1", bucket: "claim", ...CLAIM_LIMITS },
    now
  );
  if (!auth.ok) return auth.result;
  const school = auth.school;

  const parsed = parseBody(req.rawBody, claimBodySchema);
  if (!parsed.ok) return parsed.result;

  // A proof must be one this school was given a link for; the database checks again.
  if (
    parsed.data.proof_path !== undefined &&
    !isProofPathFor(parsed.data.proof_path, school.slug)
  ) {
    return {
      status: 400,
      body: { ok: false, error: "proof_path: That is not a proof uploaded for this school." },
    };
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
