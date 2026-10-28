import { NextResponse, type NextRequest } from "next/server";
import { env } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAudit } from "@/lib/audit";
import { handlePaystackWebhook } from "@/lib/paystack/webhook";

// Paystack calls this. No session: the HMAC signature on the body is the only way in
// (see lib/access.ts). Set it as the webhook URL in the Paystack dashboard.
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const admin = createAdminClient();
  const result = await handlePaystackWebhook(
    { rawBody, signature: request.headers.get("x-paystack-signature") },
    {
      secret: env.PAYSTACK_SECRET_KEY ?? null,
      recordCharge: async (c) => {
        const { data, error } = await admin.rpc("paystack_record_charge", {
          p_reference: c.reference,
          p_paystack_id: c.paystackId,
          p_paid_kobo: c.amountKobo,
          p_currency: c.currency,
        });
        if (error) throw new Error(error.message);
        return data as "applied" | "duplicate" | "needs_review" | "unknown";
      },
      audit: (action, details) =>
        writeAudit({ email: "system:paystack", role: "system" }, { action, details }),
    }
  );
  return NextResponse.json(result.body, { status: result.status });
}
