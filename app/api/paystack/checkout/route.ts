import { NextResponse, type NextRequest } from "next/server";
import { env } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAudit } from "@/lib/audit";
import { schoolAuthDeps } from "@/lib/auth/school-auth-deps";
import { handleCheckout } from "@/lib/paystack/checkout";
import { initializeTransaction } from "@/lib/paystack/client";

// A school's server asks here, signed with its own key, to pay an invoice by card.
// It gets back the Paystack page to send the payer to. See lib/access.ts.
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(request: NextRequest) {
  const admin = createAdminClient();
  const rawBody = await request.text();
  const slug = request.headers.get("x-school-slug");
  const secret = env.PAYSTACK_SECRET_KEY;
  try {
    const result = await handleCheckout(
      {
        slug,
        timestamp: request.headers.get("x-claim-timestamp"),
        signature: request.headers.get("x-claim-signature"),
        rawBody,
        ip: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      },
      {
        ...schoolAuthDeps(admin),
        configured: Boolean(secret),
        begin: async (schoolId, reference, email) => {
          const { data, error } = await admin.rpc("paystack_begin", {
            p_school: schoolId,
            p_reference: reference,
            p_email: email,
          });
          if (error) {
            if (error.code === "P0001") return { businessError: error.message };
            throw new Error(error.message);
          }
          const row = (data as { reference: string; amount_kobo: number | string }[])[0];
          return { reference: row.reference, amountKobo: Number(row.amount_kobo) };
        },
        initialize: (p) => initializeTransaction(secret!, p),
        audit: (action, schoolId, details) =>
          writeAudit({ email: `school:${slug}`, role: "school" }, { action, schoolId, details }),
      }
    );
    return NextResponse.json(result.body, { status: result.status, headers: result.headers });
  } catch {
    return NextResponse.json(
      { ok: false, error: "The payment could not be started. Try again." },
      { status: 500 }
    );
  }
}
