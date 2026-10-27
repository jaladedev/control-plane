import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { env } from "@/lib/env";
import { AccessError, requireActor } from "@/lib/auth/guards";
import { createClient } from "@/lib/supabase/server";
import { writeAudit } from "@/lib/audit";
import { DocumentError, buildDocument, issuerFrom } from "@/lib/billing/documents";
import type { SubscriptionRow, TopupRow } from "@/lib/billing/documents";
import { renderDocumentPdf } from "@/lib/billing/pdf";

// The invoice (while it waits for payment) or the receipt (once paid) as a PDF,
// for an owner or finance user to download and send. Reading a document leaves a
// trail: who fetched which invoice is in the audit log.
export const dynamic = "force-dynamic";

const plain = (error: string, status: number) =>
  NextResponse.json({ ok: false, error }, { status });

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
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
    .safeParse((await params).id);
  if (!id.success) return plain("That is not an invoice.", 404);

  // The signed-in user's own (RLS-scoped) client: only owner and finance can read these rows.
  const db = await createClient();
  const { data: sub } = await db.from("subscriptions").select("*").eq("id", id.data).maybeSingle();
  if (!sub) return plain("That invoice does not exist.", 404);
  const { data: school } = await db
    .from("schools")
    .select("name")
    .eq("id", sub.school_id as string)
    .maybeSingle();
  const { data: topups } = await db
    .from("subscription_topups")
    .select("reference, extra_students, amount_kobo, status, paid_at, line")
    .eq("subscription_id", id.data);

  let pdf: Buffer;
  let name: string;
  try {
    const model = buildDocument(
      sub as unknown as SubscriptionRow,
      (topups ?? []) as unknown as TopupRow[],
      { name: (school?.name as string) ?? "School" },
      issuerFrom({ name: env.BILLING_ISSUER_NAME, lines: env.BILLING_ISSUER_LINES })
    );
    pdf = renderDocumentPdf(model);
    name = `${model.number}.pdf`;
    await writeAudit(actor, {
      action: `${model.kind}.download`,
      schoolId: sub.school_id as string,
      details: { reference: sub.reference },
    });
  } catch (error) {
    if (error instanceof DocumentError) return plain(error.message, 409);
    return plain("The document could not be made.", 500);
  }
  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `attachment; filename="${name}"`,
      "cache-control": "no-store",
    },
  });
}
