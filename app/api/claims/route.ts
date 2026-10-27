import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAudit } from "@/lib/audit";
import { handleClaim } from "@/lib/billing/claim-endpoint";

// A school posts "I have sent the transfer" here, signed with its own Ed25519 key
// (lib/billing/claim-signature.ts). It has no session, so it is public to the login
// rules (lib/access.ts); the signature is the only way in. A claim pays nothing:
// it only puts the invoice in the Billing queue until a person confirms it.
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(request: NextRequest) {
  const admin = createAdminClient();
  const rawBody = await request.text();
  const slug = request.headers.get("x-school-slug");
  try {
    const result = await handleClaim(
      {
        slug,
        timestamp: request.headers.get("x-claim-timestamp"),
        signature: request.headers.get("x-claim-signature"),
        rawBody,
        // First address in the chain is the original caller when a proxy sets it.
        ip: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      },
      {
        findSchool: async (s) => {
          const { data } = await admin
            .from("schools")
            .select("id, status")
            .eq("slug", s)
            .maybeSingle();
          return data ? { id: data.id as string, status: data.status as string } : null;
        },
        publicKeys: async (schoolId) => {
          const { data } = await admin
            .from("school_signing_keys")
            .select("public_key")
            .eq("school_id", schoolId)
            .is("revoked_at", null);
          return (data ?? []).map((k) => k.public_key as string);
        },
        rateLimit: async (bucket, windowSeconds, max) => {
          const { data, error } = await admin.rpc("rate_limit_hit", {
            p_bucket: bucket,
            p_window_seconds: windowSeconds,
            p_max: max,
          });
          if (error) throw new Error(error.message);
          // Only an explicit "no" blocks; anything unexpected lets the school through.
          return data !== false;
        },
        audit: (action, schoolId, details) =>
          writeAudit({ email: `school:${slug}`, role: "school" }, { action, schoolId, details }),
        submit: async (schoolId, b) => {
          const { data, error } = await admin.rpc("submit_claim", {
            p_school: schoolId,
            p_reference: b.subscription_reference,
            p_client_ref: b.client_ref,
            p_amount_kobo: b.amount_kobo,
            p_sent_on: b.sent_on,
            p_sender: b.sender_name,
            p_payer_reference: b.payer_reference ?? null,
            p_proof_path: b.proof_path ?? null,
            p_claimed_by: b.claimed_by,
          });
          if (error) {
            // P0001 is one of our own "raise exception" messages, safe to show the school.
            if (error.code === "P0001") return { businessError: error.message };
            throw new Error(error.message);
          }
          return { claimId: data as string };
        },
      }
    );
    return NextResponse.json(result.body, { status: result.status, headers: result.headers });
  } catch {
    return NextResponse.json(
      { ok: false, error: "The claim could not be recorded. Try again." },
      { status: 500 }
    );
  }
}
