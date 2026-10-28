import { z } from "zod";
import {
  authenticateSchoolRequest,
  parseBody,
  type RequestResult,
  type SchoolAuthDeps,
  type SchoolRequest,
} from "@/lib/billing/school-request";
import { PROOF_MAX_BYTES, PROOF_TYPES, type ProofStore } from "@/lib/storage/proofs";

// POST /api/claims/proof: a school asks, signed, for a short-lived link to upload
// one proof of payment to the control plane's bucket. Nothing is stored here; the
// link and the path come back, the school sends the file, then names the path in
// its claim (which checks the path belongs to that school).

export const PROOF_LIMITS = {
  perAddress: { windowSeconds: 60, max: 30 },
  perSchool: { windowSeconds: 600, max: 20 },
} as const;

export const proofBodySchema = z
  .object({
    content_type: z.string().max(100),
    size_bytes: z.number().int().min(1).max(PROOF_MAX_BYTES, "The proof is larger than 5 MB."),
  })
  .strict();

export type ProofDeps = SchoolAuthDeps & {
  /** Null when the proof bucket is not configured. */
  store: ProofStore | null;
  audit(action: string, schoolId: string, details: Record<string, unknown>): Promise<void>;
};

export async function handleProofRequest(
  req: SchoolRequest,
  deps: ProofDeps,
  now: Date = new Date()
): Promise<RequestResult> {
  const auth = await authenticateSchoolRequest(
    req,
    deps,
    { purpose: "proof-v1", bucket: "proof", ...PROOF_LIMITS },
    now
  );
  if (!auth.ok) return auth.result;
  const parsed = parseBody(req.rawBody, proofBodySchema);
  if (!parsed.ok) return parsed.result;
  const { content_type, size_bytes } = parsed.data;
  if (!PROOF_TYPES[content_type]) {
    return {
      status: 400,
      body: { ok: false, error: "A proof can be a JPEG, PNG or WebP photo, or a PDF." },
    };
  }
  if (!deps.store) {
    return {
      status: 503,
      body: {
        ok: false,
        error: "Uploading a proof is not available yet. Send the claim without one.",
      },
    };
  }
  const link = deps.store.upload(auth.school.slug, content_type, size_bytes, now);
  await deps.audit("claim.proof_link", auth.school.id, {
    proof_path: link.path,
    content_type,
    size_bytes,
  });
  return {
    status: 200,
    body: {
      ok: true,
      proof_path: link.path,
      upload_url: link.url,
      upload_headers: link.headers,
      expires_in: link.expiresIn,
    },
  };
}
