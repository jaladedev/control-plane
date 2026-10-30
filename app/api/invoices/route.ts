import { NextResponse, type NextRequest } from "next/server";
import { env } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";
import { schoolAuthDeps } from "@/lib/auth/school-auth-deps";
import { issuerFrom } from "@/lib/billing/documents";
import { handleInvoices, openInvoiceFromRow } from "@/lib/billing/invoices-endpoint";
import { proofStore } from "@/lib/storage/proof-store";

// A school's server asks here, signed with its own key, which invoices are open.
// No session: the signature is the only way in (see lib/access.ts).
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(request: NextRequest) {
  const admin = createAdminClient();
  const rawBody = await request.text();
  const issuer = issuerFrom({ name: env.BILLING_ISSUER_NAME, lines: env.BILLING_ISSUER_LINES });
  try {
    const result = await handleInvoices(
      {
        slug: request.headers.get("x-school-slug"),
        timestamp: request.headers.get("x-claim-timestamp"),
        signature: request.headers.get("x-claim-signature"),
        rawBody,
        ip: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      },
      {
        ...schoolAuthDeps(admin),
        payTo: issuer,
        cardEnabled: Boolean(env.PAYSTACK_SECRET_KEY),
        proofEnabled: proofStore !== null,
        openInvoices: async (schoolId) => {
          const { data, error } = await admin
            .from("subscriptions")
            .select("reference, session, amount_kobo, status, valid_until, quote")
            .eq("school_id", schoolId)
            .in("status", ["pending", "pending_confirmation"])
            .order("created_at", { ascending: false });
          if (error) throw new Error(error.message);
          return (data ?? []).map((r) =>
            openInvoiceFromRow(r as unknown as Parameters<typeof openInvoiceFromRow>[0])
          );
        },
      }
    );
    return NextResponse.json(result.body, { status: result.status, headers: result.headers });
  } catch {
    return NextResponse.json(
      { ok: false, error: "The invoices could not be read. Try again." },
      { status: 500 }
    );
  }
}
