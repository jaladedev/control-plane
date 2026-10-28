import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAudit } from "@/lib/audit";
import { schoolAuthDeps } from "@/lib/auth/school-auth-deps";
import { handleProofRequest } from "@/lib/billing/proof-endpoint";
import { proofStore } from "@/lib/storage/proof-store";

// A school asks here, signed with its own key, for a link to upload a proof of
// payment. No session: the signature is the only way in (see lib/access.ts).
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(request: NextRequest) {
  const admin = createAdminClient();
  const rawBody = await request.text();
  const slug = request.headers.get("x-school-slug");
  try {
    const result = await handleProofRequest(
      {
        slug,
        timestamp: request.headers.get("x-claim-timestamp"),
        signature: request.headers.get("x-claim-signature"),
        rawBody,
        ip: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      },
      {
        ...schoolAuthDeps(admin),
        store: proofStore,
        audit: (action, schoolId, details) =>
          writeAudit({ email: `school:${slug}`, role: "school" }, { action, schoolId, details }),
      }
    );
    return NextResponse.json(result.body, { status: result.status, headers: result.headers });
  } catch {
    return NextResponse.json(
      { ok: false, error: "The upload link could not be made. Try again." },
      { status: 500 }
    );
  }
}
