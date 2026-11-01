import { z } from "zod";
import {
  authenticateSchoolRequest,
  parseBody,
  type RequestResult,
  type SchoolAuthDeps,
  type SchoolRequest,
} from "@/lib/billing/school-request";
import type { InitializeParams } from "@/lib/paystack/client";

// POST /api/paystack/checkout: a school's server, signed, asks to pay one invoice, or one
// top-up of a paid invoice, by card. We create the checkout row (the amount is the invoice's, from the database),
// ask Paystack for a payment page, and send its address back for the school to
// redirect the payer to. Nothing is paid until Paystack's webhook says so.

const isHttps = (u: string) => {
  try {
    return new URL(u).protocol === "https:";
  } catch {
    return false;
  }
};

export const CHECKOUT_LIMITS = {
  perAddress: { windowSeconds: 60, max: 30 },
  perSchool: { windowSeconds: 600, max: 10 },
} as const;

export const checkoutBodySchema = z
  .object({
    // Exactly one of these: an invoice (SUB-...) or a top-up (TOP-...).
    subscription_reference: z
      .string()
      .regex(/^SUB-[0-9A-F]{8}$/, "That is not an invoice reference.")
      .optional(),
    topup_reference: z
      .string()
      .regex(/^TOP-[0-9A-F]{8}$/, "That is not a top-up reference.")
      .optional(),
    payer_email: z.string().email().max(200),
    // Where Paystack sends the payer afterwards: the school's own page. https only.
    return_url: z
      .string()
      .url()
      .max(500)
      .refine(isHttps, "The return address must be https.")
      .optional(),
  })
  .strict()
  .refine(
    (b) => Boolean(b.subscription_reference) !== Boolean(b.topup_reference),
    "Name either an invoice or a top-up to pay, not both."
  );

export type CheckoutDeps = SchoolAuthDeps & {
  /** False when no Paystack secret key is set. */
  configured: boolean;
  begin(
    schoolId: string,
    reference: string,
    email: string
  ): Promise<{ reference: string; amountKobo: number } | { businessError: string }>;
  /** Same as begin, for a top-up (TOP-...) of a paid invoice. */
  beginTopup(
    schoolId: string,
    reference: string,
    email: string
  ): Promise<{ reference: string; amountKobo: number } | { businessError: string }>;
  initialize(p: InitializeParams): Promise<{ authorizationUrl: string }>;
  audit(action: string, schoolId: string, details: Record<string, unknown>): Promise<void>;
};

export async function handleCheckout(
  req: SchoolRequest,
  deps: CheckoutDeps,
  now: Date = new Date()
): Promise<RequestResult> {
  const auth = await authenticateSchoolRequest(
    req,
    deps,
    { purpose: "checkout-v1", bucket: "checkout", ...CHECKOUT_LIMITS },
    now
  );
  if (!auth.ok) return auth.result;
  const parsed = parseBody(req.rawBody, checkoutBodySchema);
  if (!parsed.ok) return parsed.result;
  if (!deps.configured) {
    return {
      status: 503,
      body: { ok: false, error: "Card payments are not available yet. Pay by bank transfer." },
    };
  }

  const { subscription_reference, topup_reference, payer_email, return_url } = parsed.data;
  const begun = topup_reference
    ? await deps.beginTopup(auth.school.id, topup_reference, payer_email)
    : await deps.begin(auth.school.id, subscription_reference!, payer_email);
  if ("businessError" in begun) {
    return { status: 409, body: { ok: false, error: begun.businessError } };
  }
  const what: Record<string, string> = topup_reference
    ? { topup: topup_reference }
    : { invoice: subscription_reference as string };
  await deps.audit("paystack.checkout", auth.school.id, {
    ...what,
    reference: begun.reference,
    amount_kobo: begun.amountKobo,
  });
  try {
    const { authorizationUrl } = await deps.initialize({
      email: payer_email,
      amountKobo: begun.amountKobo,
      reference: begun.reference,
      callbackUrl: return_url,
      metadata: { school: auth.school.slug, ...what },
    });
    return {
      status: 201,
      body: { ok: true, authorization_url: authorizationUrl, reference: begun.reference },
    };
  } catch {
    return {
      status: 502,
      body: {
        ok: false,
        error: "Card payments are not responding. Try again, or pay by transfer.",
      },
    };
  }
}
