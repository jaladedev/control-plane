import { z } from "zod";
import {
  buildDocument,
  DocumentError,
  type SubscriptionRow,
  type TopupRow,
} from "@/lib/billing/documents";
import { renderDocumentPdf } from "@/lib/billing/pdf";
import {
  authenticateSchoolRequest,
  parseBody,
  type RequestResult,
  type SchoolAuthDeps,
  type SchoolRequest,
} from "@/lib/billing/school-request";

// POST /api/receipts (the list) and POST /api/receipts/pdf (one receipt), signed by a
// school's server. Read-only. A school sees only its own paid invoices, and only the
// receipt, never an invoice it has not paid.

export const RECEIPTS_LIMITS = {
  perAddress: { windowSeconds: 60, max: 60 },
  perSchool: { windowSeconds: 600, max: 60 },
} as const;
export const RECEIPT_PDF_LIMITS = {
  perAddress: { windowSeconds: 60, max: 30 },
  perSchool: { windowSeconds: 600, max: 30 },
} as const;

export type PaidInvoice = {
  reference: string;
  session: string;
  /** The invoice plus any paid top-ups. */
  totalKobo: number;
  status: "paid" | "refunded";
  paidAt: string;
  method: string | null;
};

export type ReceiptsDeps = SchoolAuthDeps & {
  paidInvoices(schoolId: string): Promise<PaidInvoice[]>;
};

export function paidInvoiceFromRow(r: {
  reference: string;
  session: string;
  amount_kobo: number | string;
  topup_kobo: number | string;
  status: string;
  paid_at: string;
  method: string | null;
}): PaidInvoice {
  return {
    reference: r.reference,
    session: r.session,
    totalKobo: Number(r.amount_kobo) + Number(r.topup_kobo),
    status: r.status === "refunded" ? "refunded" : "paid",
    paidAt: r.paid_at.slice(0, 10),
    method: r.method,
  };
}

export async function handleReceipts(
  req: SchoolRequest,
  deps: ReceiptsDeps,
  now: Date = new Date()
): Promise<RequestResult> {
  const auth = await authenticateSchoolRequest(
    req,
    deps,
    { purpose: "receipts-v1", bucket: "receipts", ...RECEIPTS_LIMITS },
    now
  );
  if (!auth.ok) return auth.result;
  const parsed = parseBody(req.rawBody, z.object({}).strict());
  if (!parsed.ok) return parsed.result;
  const paid = await deps.paidInvoices(auth.school.id);
  return {
    status: 200,
    body: {
      ok: true,
      receipts: paid.map((p) => ({
        reference: p.reference,
        session: p.session,
        total_kobo: p.totalKobo,
        status: p.status,
        paid_at: p.paidAt,
        method: p.method,
      })),
    },
  };
}

export type ReceiptPdfDeps = SchoolAuthDeps & {
  /** The school's own invoice with this reference, or null. Never another school's. */
  loadInvoice(
    schoolId: string,
    reference: string
  ): Promise<{ sub: SubscriptionRow; topups: TopupRow[]; schoolName: string } | null>;
  issuer: { name: string; lines: string[] };
  audit(action: string, schoolId: string, details: Record<string, unknown>): Promise<void>;
};

export type PdfResult =
  { kind: "json"; result: RequestResult } | { kind: "pdf"; pdf: Buffer; filename: string };

export async function handleReceiptPdf(
  req: SchoolRequest,
  deps: ReceiptPdfDeps,
  now: Date = new Date()
): Promise<PdfResult> {
  const auth = await authenticateSchoolRequest(
    req,
    deps,
    { purpose: "receipts-v1", bucket: "receipt-pdf", ...RECEIPT_PDF_LIMITS },
    now
  );
  if (!auth.ok) return { kind: "json", result: auth.result };
  const parsed = parseBody(
    req.rawBody,
    z
      .object({
        reference: z.string().regex(/^SUB-[0-9A-F]{8}$/, "That is not an invoice reference."),
      })
      .strict()
  );
  if (!parsed.ok) return { kind: "json", result: parsed.result };

  const found = await deps.loadInvoice(auth.school.id, parsed.data.reference);
  const notFound: PdfResult = {
    kind: "json",
    result: {
      status: 404,
      body: { ok: false, error: "There is no receipt for that invoice." },
    },
  };
  if (!found) return notFound;
  let model;
  try {
    model = buildDocument(found.sub, found.topups, { name: found.schoolName }, deps.issuer);
  } catch (error) {
    if (error instanceof DocumentError) return notFound;
    throw error;
  }
  // An unpaid invoice is not a receipt, and a school asks for receipts here.
  if (model.kind !== "receipt") return notFound;

  await deps.audit("receipt.school_download", auth.school.id, {
    reference: parsed.data.reference,
  });
  return { kind: "pdf", pdf: renderDocumentPdf(model), filename: `${model.number}.pdf` };
}
