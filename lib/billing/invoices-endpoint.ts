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

export type InvoicesDeps = SchoolAuthDeps & {
  openInvoices(schoolId: string): Promise<OpenInvoice[]>;
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

  const invoices = await deps.openInvoices(auth.school.id);
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
      pay_to: deps.payTo,
      card_enabled: deps.cardEnabled,
      proof_enabled: deps.proofEnabled,
    },
  };
}
