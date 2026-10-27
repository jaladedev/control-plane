import type { DocumentModel } from "@/lib/billing/pdf";
import type { Quote } from "@/lib/billing/quote";

// Turns the rows behind an invoice into what its PDF shows. Pure: the route reads
// the rows, this decides what they say. An invoice keeps the quote it was made
// with, so a PDF printed next year matches the one printed today.

export type SubscriptionRow = {
  reference: string;
  session: string;
  status: string;
  amount_kobo: number | string;
  topup_kobo: number | string;
  method: string | null;
  payment_ref: string | null;
  paid_at: string | null;
  valid_until: string;
  created_at: string;
  refunded_at: string | null;
  refund_kobo: number | string | null;
  quote: Quote;
};

export type TopupRow = {
  reference: string;
  extra_students: number;
  amount_kobo: number | string;
  status: string;
  paid_at: string | null;
  line: { unit_kobo?: number | string } | null;
};

export class DocumentError extends Error {}

const day = (iso: string) => iso.slice(0, 10);
const METHODS: Record<string, string> = { transfer: "bank transfer", paystack: "card (Paystack)" };

export function issuerFrom(env: { name?: string; lines?: string }) {
  return {
    name: (env.name ?? "").trim(),
    lines: (env.lines ?? "")
      .split("|")
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, 6),
  };
}

export function buildDocument(
  sub: SubscriptionRow,
  topups: TopupRow[],
  school: { name: string },
  issuer: { name: string; lines: string[] }
): DocumentModel {
  const receipt = sub.status === "paid" || sub.status === "refunded";
  const invoice = sub.status === "pending" || sub.status === "pending_confirmation";
  if (!receipt && !invoice) {
    throw new DocumentError(
      sub.status === "cancelled"
        ? "A cancelled invoice has no document."
        : "There is no document for this invoice."
    );
  }
  if (receipt && !sub.paid_at) throw new DocumentError("This invoice has no payment date.");

  const lines = (sub.quote.lines ?? []).map((l) => ({
    description: l.override
      ? `${l.label} (${l.override.kind === "percent" ? `${l.override.value}% off list` : "special price"})`
      : l.label,
    quantity: l.quantity,
    unitKobo: l.unit_kobo,
    totalKobo: l.total_kobo,
  }));
  // Paid top-ups are part of what the school paid for this session.
  if (receipt) {
    for (const t of topups.filter(
      (t) => t.paid_at && (t.status === "paid" || t.status === "refunded")
    )) {
      const total = Number(t.amount_kobo);
      lines.push({
        description: `Top-up ${t.reference}: ${t.extra_students} extra students`,
        quantity: t.extra_students,
        unitKobo: Number(t.line?.unit_kobo ?? Math.round(total / t.extra_students)),
        totalKobo: total,
      });
    }
  }
  const totalKobo = lines.reduce((sum, l) => sum + l.totalKobo, 0);
  const expected = Number(sub.amount_kobo) + (receipt ? Number(sub.topup_kobo) : 0);
  if (totalKobo !== expected) {
    throw new DocumentError(
      "The invoice lines do not add up to its total, so no document was made."
    );
  }

  return {
    kind: receipt ? "receipt" : "invoice",
    number: receipt ? `RCT-${sub.reference.slice(4)}` : sub.reference,
    issuedOn: day(receipt ? sub.paid_at! : sub.created_at),
    issuer,
    school,
    session: sub.session,
    validUntil: day(sub.valid_until),
    reference: sub.reference,
    lines,
    totalKobo,
    payment: receipt
      ? {
          method: METHODS[sub.method ?? ""] ?? sub.method ?? "payment",
          reference: sub.payment_ref ?? sub.reference,
          paidOn: day(sub.paid_at!),
        }
      : undefined,
    refund:
      sub.status === "refunded" && sub.refunded_at
        ? { onDate: day(sub.refunded_at), amountKobo: Number(sub.refund_kobo ?? totalKobo) }
        : undefined,
  };
}
