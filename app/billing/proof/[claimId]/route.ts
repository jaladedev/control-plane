import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { AccessError, requireActor } from "@/lib/auth/guards";
import { createClient } from "@/lib/supabase/server";
import { writeAudit } from "@/lib/audit";
import { proofStore } from "@/lib/storage/proof-store";

// Opens the proof of payment attached to a claim. Owner and finance only. The proof
// itself stays in the bucket: this answers with a redirect to a link that works for
// two minutes, after the view has been written to the audit log.
export const dynamic = "force-dynamic";

const plain = (error: string, status: number) =>
  NextResponse.json({ ok: false, error }, { status });

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ claimId: string }> }
) {
  let actor;
  try {
    actor = await requireActor(["owner", "finance"]);
  } catch (error) {
    if (error instanceof AccessError) {
      return plain(
        error.message,
        error.code === "signed_out" || error.code === "needs_2fa" ? 401 : 403
      );
    }
    throw error;
  }
  const id = z
    .string()
    .uuid()
    .safeParse((await params).claimId);
  if (!id.success) return plain("That is not a claim.", 404);
  if (!proofStore) return plain("Proofs of payment are not set up on this server.", 503);

  // The signed-in user's own (RLS-scoped) client: only owner and finance can read claims.
  const db = await createClient();
  const { data: claim } = await db
    .from("payment_claims")
    .select("school_id, proof_path")
    .eq("id", id.data)
    .maybeSingle();
  if (!claim) return plain("That claim does not exist.", 404);
  if (!claim.proof_path) return plain("This claim has no proof attached.", 404);

  let link: string;
  try {
    link = proofStore.view(claim.proof_path as string);
    await writeAudit(actor, {
      action: "claim.proof_view",
      schoolId: claim.school_id as string,
      details: { claim_id: id.data, proof_path: claim.proof_path },
    });
  } catch {
    return plain("The proof could not be opened.", 500);
  }
  return new NextResponse(null, {
    status: 302,
    headers: {
      location: link,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
}
