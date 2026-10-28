import { z } from "zod";
import { verifyPaystackSignature } from "@/lib/paystack/signature";

// POST /api/paystack/webhook. Paystack calls this when a card payment succeeds. The
// handler only RECORDS the payment: a database function matches it to an invoice,
// checks the amount and currency, and either pays the invoice or flags it for a
// person. Paystack is told 200 for anything it should not resend (including a charge
// that needs review: the money is safe in our table, resending would not help), and
// 5xx only when we could not write it down, so that Paystack tries again.

export type WebhookResult = { status: number; body: Record<string, unknown> };

export type WebhookDeps = {
  /** The secret key, or null when card payments are not set up. */
  secret: string | null;
  recordCharge(charge: {
    reference: string;
    paystackId: string;
    amountKobo: number;
    currency: string;
  }): Promise<"applied" | "duplicate" | "needs_review" | "unknown">;
  audit(action: string, details: Record<string, unknown>): Promise<void>;
};

const MAX_BODY_BYTES = 64 * 1024;

const chargeSchema = z.object({
  event: z.string(),
  data: z.object({
    id: z.union([z.number().int().positive(), z.string().min(1).max(40)]),
    reference: z.string().regex(/^PSK-[0-9A-F]{16}$/),
    amount: z.number().int().positive(),
    currency: z.string().min(1).max(8),
    status: z.string(),
  }),
});

export async function handlePaystackWebhook(
  req: { rawBody: string; signature: string | null },
  deps: WebhookDeps
): Promise<WebhookResult> {
  if (!deps.secret) {
    return { status: 503, body: { ok: false, error: "Card payments are not set up." } };
  }
  if (Buffer.byteLength(req.rawBody) > MAX_BODY_BYTES) {
    return { status: 413, body: { ok: false } };
  }
  if (!verifyPaystackSignature(req.rawBody, req.signature, deps.secret)) {
    return { status: 401, body: { ok: false } };
  }

  let json: unknown;
  try {
    json = JSON.parse(req.rawBody);
  } catch {
    return { status: 400, body: { ok: false } };
  }
  // Signed by Paystack, so anything that is not a charge we recognise is simply
  // not for us (refund notices, other products on the same account): acknowledge it.
  const parsed = chargeSchema.safeParse(json);
  if (
    !parsed.success ||
    parsed.data.event !== "charge.success" ||
    parsed.data.data.status !== "success"
  ) {
    return { status: 200, body: { ok: true, ignored: true } };
  }

  const { id, reference, amount, currency } = parsed.data.data;
  let result: Awaited<ReturnType<WebhookDeps["recordCharge"]>>;
  try {
    result = await deps.recordCharge({
      reference,
      paystackId: String(id),
      amountKobo: amount,
      currency,
    });
  } catch {
    return { status: 500, body: { ok: false } };
  }
  if (result !== "duplicate" && result !== "unknown") {
    try {
      await deps.audit(`paystack.charge_${result}`, {
        reference,
        paystack_id: String(id),
        amount_kobo: amount,
        currency,
      });
    } catch {
      // The payment is recorded in its own table; a missed audit row must not make
      // Paystack resend a charge that is already dealt with.
    }
  }
  return { status: 200, body: { ok: true, result } };
}
