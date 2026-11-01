import { z } from "zod";
import {
  authenticateSchoolRequest,
  parseBody,
  type RequestResult,
  type SchoolAuthDeps,
  type SchoolRequest,
} from "@/lib/billing/school-request";

// POST /api/invoices: a school's server, signed, asks which invoices are open and
// where to pay. Read-only. It exists so the school's renewal screen can show what is
// owed and offer to pay it, instead of asking a bursar to copy a reference from an
// emailed PDF. A school only ever sees its own invoices.

export const INVOICES_LIMITS = {
  perAddress: { windowSeconds: 60, max: 60 },
  perSchool: { windowSeconds: 600, max: 60 },
} as const;

export type OpenInvoice = {
  reference: string;
  session: string;
  amountKobo: number;
  /** pending: waiting for payment. pending_confirmation: a transfer claim is being checked. */
  status: "pending" | "pending_confirmation";
  validUntil: string;
  lines: { label: string; quantity: number; totalKobo: number }[];
};

/** One `subscriptions` row as the open-invoice list shows it. */
export function openInvoiceFromRow(r: {
  reference: string;
  session: string;
  amount_kobo: number | string;
  status: string;
  valid_until: string;
  quote: { lines?: { label: string; quantity: number; total_kobo: number }[] } | null;
}): OpenInvoice {
  return {
    reference: r.reference,
    session: r.session,
    amountKobo: Number(r.amount_kobo),
    status: r.status === "pending_confirmation" ? "pending_confirmation" : "pending",
    validUntil: r.valid_until.slice(0, 10),
    lines: (r.quote?.lines ?? []).map((l) => ({
      label: l.label,
      quantity: l.quantity,
      totalKobo: l.total_kobo,
    })),
  };
}

/** Extra students invoiced on a paid invoice, waiting for payment. Payable by card. */
export type OpenTopup = {
  reference: string;
  /** The paid invoice it belongs to. */
  invoiceReference: string;
  session: string;
  extraStudents: number;
  amountKobo: number;
};

/** One `subscription_topups` row (with its invoice) as the open list shows it. */
export function openTopupFromRow(r: {
  reference: string;
  extra_students: number;
  amount_kobo: number | string;
  subscriptions:
    { reference: string; session: string } | { reference: string; session: string }[] | null;
}): OpenTopup {
  const inv = Array.isArray(r.subscriptions) ? r.subscriptions[0] : r.subscriptions;
  return {
    reference: r.reference,
    invoiceReference: inv?.reference ?? "",
    session: inv?.session ?? "",
    extraStudents: r.extra_students,
    amountKobo: Number(r.amount_kobo),
  };
}

export type InvoicesDeps = SchoolAuthDeps & {
  openInvoices(schoolId: string): Promise<OpenInvoice[]>;
  openTopups(schoolId: string): Promise<OpenTopup[]>;
  /** Who to pay and where: the issuer's name and bank details. */
  payTo: { name: string; lines: string[] };
  cardEnabled: boolean;
  proofEnabled: boolean;
};

export async function handleInvoices(
  req: SchoolRequest,
  deps: InvoicesDeps,
  now: Date = new Date()
): Promise<RequestResult> {
  const auth = await authenticateSchoolRequest(
    req,
    deps,
    { purpose: "invoices-v1", bucket: "invoices", ...INVOICES_LIMITS },
    now
  );
  if (!auth.ok) return auth.result;
  const parsed = parseBody(req.rawBody, z.object({}).strict());
  if (!parsed.ok) return parsed.result;

  const [invoices, topups] = await Promise.all([
    deps.openInvoices(auth.school.id),
    deps.openTopups(auth.school.id),
  ]);
  return {
    status: 200,
    body: {
      ok: true,
      invoices: invoices.map((i) => ({
        reference: i.reference,
        session: i.session,
        amount_kobo: i.amountKobo,
        status: i.status,
        valid_until: i.validUntil,
        lines: i.lines.map((l) => ({
          label: l.label,
          quantity: l.quantity,
          total_kobo: l.totalKobo,
        })),
      })),
      topups: topups.map((t) => ({
        reference: t.reference,
        invoice_reference: t.invoiceReference,
        session: t.session,
        extra_students: t.extraStudents,
        amount_kobo: t.amountKobo,
      })),
      pay_to: deps.payTo,
      card_enabled: deps.cardEnabled,
      proof_enabled: deps.proofEnabled,
    },
  };
}
