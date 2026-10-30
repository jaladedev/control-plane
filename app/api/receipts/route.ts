import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { schoolAuthDeps } from "@/lib/auth/school-auth-deps";
import { handleReceipts, paidInvoiceFromRow } from "@/lib/billing/receipts-endpoint";

// A school's server asks here, signed, for the list of invoices it has paid.
// No session: the signature is the only way in (see lib/access.ts).
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(request: NextRequest) {
  const admin = createAdminClient();
  const rawBody = await request.text();
  try {
    const result = await handleReceipts(
      {
        slug: request.headers.get("x-school-slug"),
        timestamp: request.headers.get("x-claim-timestamp"),
        signature: request.headers.get("x-claim-signature"),
        rawBody,
        ip: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      },
      {
        ...schoolAuthDeps(admin),
        paidInvoices: async (schoolId) => {
          const { data, error } = await admin
            .from("subscriptions")
            .select("reference, session, amount_kobo, topup_kobo, status, paid_at, method")
            .eq("school_id", schoolId)
            .in("status", ["paid", "refunded"])
            .order("paid_at", { ascending: false })
            .limit(50);
          if (error) throw new Error(error.message);
          return (data ?? []).map((r) =>
            paidInvoiceFromRow(r as unknown as Parameters<typeof paidInvoiceFromRow>[0])
          );
        },
      }
    );
    return NextResponse.json(result.body, { status: result.status, headers: result.headers });
  } catch {
    return NextResponse.json(
      { ok: false, error: "The receipts could not be read. Try again." },
      { status: 500 }
    );
  }
}
