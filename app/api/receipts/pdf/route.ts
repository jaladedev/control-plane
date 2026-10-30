import { NextResponse, type NextRequest } from "next/server";
import { env } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAudit } from "@/lib/audit";
import { schoolAuthDeps } from "@/lib/auth/school-auth-deps";
import { issuerFrom } from "@/lib/billing/documents";
import type { SubscriptionRow, TopupRow } from "@/lib/billing/documents";
import { handleReceiptPdf } from "@/lib/billing/receipts-endpoint";

// A school's server asks here, signed, for the PDF receipt of one invoice it has paid.
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(request: NextRequest) {
  const admin = createAdminClient();
  const rawBody = await request.text();
  const slug = request.headers.get("x-school-slug");
  try {
    const out = await handleReceiptPdf(
      {
        slug,
        timestamp: request.headers.get("x-claim-timestamp"),
        signature: request.headers.get("x-claim-signature"),
        rawBody,
        ip: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      },
      {
        ...schoolAuthDeps(admin),
        issuer: issuerFrom({ name: env.BILLING_ISSUER_NAME, lines: env.BILLING_ISSUER_LINES }),
        loadInvoice: async (schoolId, reference) => {
          const { data: sub } = await admin
            .from("subscriptions")
            .select("*")
            .eq("school_id", schoolId)
            .eq("reference", reference)
            .maybeSingle();
          if (!sub) return null;
          const { data: school } = await admin
            .from("schools")
            .select("name")
            .eq("id", schoolId)
            .maybeSingle();
          const { data: topups } = await admin
            .from("subscription_topups")
            .select("reference, extra_students, amount_kobo, status, paid_at, line")
            .eq("subscription_id", sub.id as string);
          return {
            sub: sub as unknown as SubscriptionRow,
            topups: (topups ?? []) as unknown as TopupRow[],
            schoolName: (school?.name as string) ?? "School",
          };
        },
        audit: (action, schoolId, details) =>
          writeAudit({ email: `school:${slug}`, role: "school" }, { action, schoolId, details }),
      }
    );
    if (out.kind === "json") {
      return NextResponse.json(out.result.body, {
        status: out.result.status,
        headers: out.result.headers,
      });
    }
    return new NextResponse(new Uint8Array(out.pdf), {
      headers: {
        "content-type": "application/pdf",
        "content-disposition": `attachment; filename="${out.filename}"`,
        "cache-control": "no-store",
      },
    });
  } catch {
    return NextResponse.json(
      { ok: false, error: "The receipt could not be made. Try again." },
      { status: 500 }
    );
  }
}
