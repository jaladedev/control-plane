import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireActor } from "@/lib/auth/guards";
import { withAudit } from "@/lib/audit";
import { isKeyEncoding } from "@/lib/billing/claim-signature";
import { nairaToKobo } from "@/lib/billing/money";
import {
  buildQuote,
  priceAt,
  type OverrideRow,
  type PriceRow,
  type Quote,
} from "@/lib/billing/quote";

// Invoices, claims, prices. Owner and finance run billing day to day; only the
// owner changes prices, overrides and signing keys. Every action that changes
// something writes its audit row first and then calls one database function, which
// enforces the rules again (a reason on every money decision, an amount that must
// match the invoice, one open invoice per session, and so on). The database's
// refusals are written for people, so they are passed through as they are.

const BILLING = ["owner", "finance"] as const;
const OWNER = ["owner"] as const;

type Admin = ReturnType<typeof createAdminClient>;

async function rpc(admin: Admin, fn: string, args: Record<string, unknown>) {
  const { data, error } = await admin.rpc(fn, args);
  if (error) throw new Error(error.message);
  return data;
}

const blank = (v: unknown) => (v === "" || v === null || v === undefined ? undefined : v);
const reasonSchema = z
  .string()
  .trim()
  .min(1, "A reason is required.")
  .max(500, "The reason is at most 500 characters.");
const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Enter a date like 2027-07-31.")
  .refine(
    (d) =>
      !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) &&
      new Date(`${d}T00:00:00Z`).toISOString().startsWith(d),
    "That is not a real date."
  );

const endOfDayUtc = (date: string) => new Date(`${date}T23:59:59Z`);
const addDays = (d: Date, days: number) => new Date(d.getTime() + days * 86_400_000);

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------

const invoiceSchema = z.object({
  schoolId: z.string().uuid("Choose a school."),
  session: z.string().trim().min(1, "Enter the academic session.").max(40),
  validUntil: dateSchema,
  graceDays: z.preprocess(blank, z.coerce.number().int().min(0).max(180).default(14)),
  extraStudents: z.preprocess(blank, z.coerce.number().int().min(0).max(100_000).default(0)),
  features: z.preprocess((v) => (typeof v === "string" ? v : ""), z.string()).default(""),
  proHosting: z.preprocess((v) => v === "on" || v === "true" || v === true, z.boolean()),
});

export type InvoicePlan = {
  school: { id: string; name: string; slug: string };
  quote: Quote;
  validUntil: Date;
  graceUntil: Date;
};

async function planInvoice(admin: Admin, input: unknown): Promise<InvoicePlan> {
  const v = invoiceSchema.parse(input);
  const { data: school } = await admin
    .from("schools")
    .select("id, name, slug, status, included_students")
    .eq("id", v.schoolId)
    .maybeSingle();
  if (!school) throw new Error("That school does not exist.");
  if (school.status !== "active") throw new Error("Only an active school can be invoiced.");

  const validUntil = endOfDayUtc(v.validUntil);
  if (validUntil.getTime() <= Date.now()) throw new Error("The valid-until date is in the past.");

  const { data: prices } = await admin
    .from("price_catalog")
    .select("item, amount_kobo, count, effective_from, created_at");
  const { data: overrides } = await admin
    .from("school_price_overrides")
    .select("item, session, amount_kobo, percent_off, reason, created_at")
    .eq("school_id", v.schoolId);

  const features = v.features.split(/[\s,]+/).filter(Boolean);
  const quote = buildQuote({
    session: v.session,
    asOf: new Date(),
    prices: (prices ?? []) as PriceRow[],
    overrides: (overrides ?? []) as OverrideRow[],
    schoolIncludedStudents: Number(school.included_students ?? 0),
    extraStudents: v.extraStudents,
    features,
    proHosting: v.proHosting,
  });
  return {
    school: { id: school.id as string, name: school.name as string, slug: school.slug as string },
    quote,
    validUntil,
    graceUntil: addDays(validUntil, v.graceDays),
  };
}

/** The quote as it would be saved, for the preview screen. Changes nothing. */
export async function previewInvoice(input: unknown): Promise<InvoicePlan> {
  await requireActor(BILLING);
  return planInvoice(createAdminClient(), input);
}

export async function createInvoice(input: unknown): Promise<{ id: string }> {
  const actor = await requireActor(BILLING);
  const admin = createAdminClient();
  const plan = await planInvoice(admin, input);
  const { quote } = plan;

  return withAudit(
    actor,
    {
      action: "subscription.create",
      schoolId: plan.school.id,
      details: {
        session: quote.session,
        total_kobo: quote.total_kobo,
        valid_until: plan.validUntil.toISOString(),
        lines: quote.lines.map((l) => ({
          item: l.item,
          total_kobo: l.total_kobo,
          override: l.override?.kind ?? null,
        })),
      },
    },
    async () => ({
      id: (await rpc(admin, "create_subscription", {
        p_school: plan.school.id,
        p_session: quote.session,
        p_included: quote.included_students,
        p_extra: quote.extra_students,
        p_amount: quote.total_kobo,
        p_valid_until: plan.validUntil.toISOString(),
        p_grace_until: plan.graceUntil.toISOString(),
        p_items: quote.lines
          .filter((l) => l.item.startsWith("feature:"))
          .map((l) => ({ feature: l.item.slice(8), amount_kobo: l.total_kobo })),
        p_quote: quote,
        p_by: actor.email,
      })) as string,
    })
  );
}

async function subscriptionSchool(admin: Admin, id: string) {
  const { data } = await admin
    .from("subscriptions")
    .select("school_id, reference")
    .eq("id", id)
    .maybeSingle();
  if (!data) throw new Error("That invoice does not exist.");
  return { schoolId: data.school_id as string, reference: data.reference as string };
}

export async function cancelInvoice(subscriptionId: string, reason: unknown): Promise<void> {
  const actor = await requireActor(BILLING);
  const id = z.string().uuid().parse(subscriptionId);
  const why = reasonSchema.parse(reason);
  const admin = createAdminClient();
  const sub = await subscriptionSchool(admin, id);
  await withAudit(
    actor,
    {
      action: "subscription.cancel",
      schoolId: sub.schoolId,
      details: { reference: sub.reference, reason: why },
    },
    () => rpc(admin, "cancel_subscription", { p_sub: id, p_by: actor.email, p_reason: why })
  );
}

export async function markInvoicePaid(
  subscriptionId: string,
  paymentRef: unknown,
  reason: unknown
): Promise<void> {
  const actor = await requireActor(BILLING);
  const id = z.string().uuid().parse(subscriptionId);
  const ref = z.preprocess(blank, z.string().trim().max(120).optional()).parse(paymentRef);
  const why = reasonSchema.parse(reason);
  const admin = createAdminClient();
  const sub = await subscriptionSchool(admin, id);
  await withAudit(
    actor,
    {
      action: "subscription.mark_paid",
      schoolId: sub.schoolId,
      details: { reference: sub.reference, payment_ref: ref ?? null, reason: why },
    },
    () =>
      rpc(admin, "mark_subscription_paid", {
        p_sub: id,
        p_ref: ref ?? "",
        p_by: actor.email,
        p_reason: why,
      })
  );
}

export async function extendInvoice(
  subscriptionId: string,
  validUntil: unknown,
  graceDays: unknown,
  reason: unknown
): Promise<void> {
  const actor = await requireActor(BILLING);
  const id = z.string().uuid().parse(subscriptionId);
  const until = endOfDayUtc(dateSchema.parse(validUntil));
  const grace = z
    .preprocess(blank, z.coerce.number().int().min(0).max(180).default(14))
    .parse(graceDays);
  const why = reasonSchema.parse(reason);
  const admin = createAdminClient();
  const sub = await subscriptionSchool(admin, id);
  await withAudit(
    actor,
    {
      action: "subscription.extend",
      schoolId: sub.schoolId,
      details: {
        reference: sub.reference,
        valid_until: until.toISOString(),
        grace_days: grace,
        reason: why,
      },
    },
    () =>
      rpc(admin, "extend_subscription", {
        p_sub: id,
        p_valid_until: until.toISOString(),
        p_grace_until: addDays(until, grace).toISOString(),
        p_by: actor.email,
        p_reason: why,
      })
  );
}

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------

async function claimSchool(admin: Admin, id: string) {
  const { data } = await admin
    .from("payment_claims")
    .select("school_id, subscription_id")
    .eq("id", id)
    .maybeSingle();
  if (!data) throw new Error("That claim does not exist.");
  return { schoolId: data.school_id as string };
}

/**
 * Confirm = a person checked the bank statement. The amount typed is what the
 * bank shows, and the database refuses it unless it equals the invoice.
 */
export async function confirmClaim(
  claimId: string,
  amountNaira: unknown,
  reason: unknown
): Promise<void> {
  const actor = await requireActor(BILLING);
  const id = z.string().uuid().parse(claimId);
  const amount = nairaToKobo(z.string().parse(amountNaira));
  const why = reasonSchema.parse(reason);
  const admin = createAdminClient();
  const claim = await claimSchool(admin, id);
  await withAudit(
    actor,
    {
      action: "claim.confirm",
      schoolId: claim.schoolId,
      details: { claim_id: id, amount_kobo: amount, reason: why },
    },
    () =>
      rpc(admin, "confirm_claim", {
        p_claim: id,
        p_amount_kobo: amount,
        p_by: actor.email,
        p_reason: why,
      })
  );
}

export async function rejectClaim(claimId: string, reason: unknown): Promise<void> {
  const actor = await requireActor(BILLING);
  const id = z.string().uuid().parse(claimId);
  const why = reasonSchema.parse(reason);
  const admin = createAdminClient();
  const claim = await claimSchool(admin, id);
  await withAudit(
    actor,
    { action: "claim.reject", schoolId: claim.schoolId, details: { claim_id: id, reason: why } },
    () => rpc(admin, "reject_claim", { p_claim: id, p_by: actor.email, p_reason: why })
  );
}

// ---------------------------------------------------------------------------
// Prices (owner only)
// ---------------------------------------------------------------------------

const itemSchema = z
  .string()
  .regex(
    /^(base_fee|included_students|extra_student|pro_hosting|feature:[a-z][a-z0-9_]{1,39})$/,
    "Choose an item, or write add-ons as feature:name."
  );

export const BIG_CHANGE_PERCENT = 25;

export async function setPrice(input: {
  item: unknown;
  value: unknown;
  effectiveFrom?: unknown;
  reason: unknown;
  confirm?: unknown;
}): Promise<{ id: string }> {
  const actor = await requireActor(OWNER);
  const item = itemSchema.parse(input.item);
  const why = reasonSchema.parse(input.reason);
  const valueText = z.string().trim().min(1, "Enter a value.").parse(input.value);
  const isCount = item === "included_students";
  let amount: number | null = null;
  let count: number | null = null;
  if (isCount) {
    if (!/^\d{1,6}$/.test(valueText.replace(/,/g, "")))
      throw new Error("Enter a whole number of students.");
    count = Number(valueText.replace(/,/g, ""));
  } else {
    amount = nairaToKobo(valueText);
  }

  let effective: Date | undefined;
  const dateText = blank(input.effectiveFrom);
  if (dateText !== undefined) {
    const d = new Date(`${dateSchema.parse(dateText)}T00:00:00Z`);
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    if (d.getTime() < today.getTime()) throw new Error("A price cannot start in the past.");
    effective = d;
  }

  const admin = createAdminClient();
  const { data: rows } = await admin
    .from("price_catalog")
    .select("item, amount_kobo, count, effective_from, created_at")
    .eq("item", item);
  const current = priceAt((rows ?? []) as PriceRow[], item, effective ?? new Date());
  const before = current ? (isCount ? current.count : current.amount_kobo) : null;
  const after = isCount ? count : amount;
  if (before && before > 0 && after !== null) {
    const change = Math.round((Math.abs(after - before) / before) * 100);
    if (change > BIG_CHANGE_PERCENT && String(input.confirm ?? "").trim() !== "CHANGE") {
      throw new Error(`This changes the price by ${change}%. To confirm, type CHANGE.`);
    }
  }

  return withAudit(
    actor,
    {
      action: "price.set",
      details: {
        item,
        from: before,
        to: after,
        effective_from: effective?.toISOString() ?? "now",
        reason: why,
      },
    },
    async () => ({
      id: (await rpc(admin, "set_price", {
        p_item: item,
        p_amount_kobo: amount,
        p_count: count,
        p_effective_from: effective?.toISOString() ?? null,
        p_reason: why,
        p_by: actor.email,
      })) as string,
    })
  );
}

const overrideSchema = z.object({
  schoolId: z.string().uuid("Choose a school."),
  item: itemSchema.refine(
    (i) => i !== "included_students",
    "The student allowance has no override."
  ),
  session: z.string().trim().min(1, "Enter the academic session.").max(40),
  kind: z.enum(["amount", "percent"]),
  value: z.string().trim().min(1, "Enter a value."),
  reason: reasonSchema,
});

export async function setPriceOverride(input: unknown): Promise<{ id: string }> {
  const actor = await requireActor(OWNER);
  const v = overrideSchema.parse(input);
  let amount: number | null = null;
  let percent: number | null = null;
  if (v.kind === "amount") {
    amount = nairaToKobo(v.value);
  } else {
    if (!/^\d{1,3}$/.test(v.value) || Number(v.value) < 1 || Number(v.value) > 100) {
      throw new Error("A percentage is a whole number from 1 to 100.");
    }
    percent = Number(v.value);
  }
  const admin = createAdminClient();
  return withAudit(
    actor,
    {
      action: "price.override",
      schoolId: v.schoolId,
      details: {
        item: v.item,
        session: v.session,
        amount_kobo: amount,
        percent_off: percent,
        reason: v.reason,
      },
    },
    async () => ({
      id: (await rpc(admin, "set_price_override", {
        p_school: v.schoolId,
        p_item: v.item,
        p_session: v.session,
        p_amount_kobo: amount,
        p_percent_off: percent,
        p_reason: v.reason,
        p_by: actor.email,
      })) as string,
    })
  );
}

// ---------------------------------------------------------------------------
// Signing keys (owner only)
// ---------------------------------------------------------------------------

export async function addSigningKey(schoolId: string, publicKey: unknown): Promise<{ id: string }> {
  const actor = await requireActor(OWNER);
  const school = z.string().uuid().parse(schoolId);
  const key = z.string().trim().parse(publicKey);
  if (!isKeyEncoding(key)) {
    throw new Error(
      "A public key is 43 characters of letters, digits, dashes and underscores (the school's claim key generator prints it)."
    );
  }
  const admin = createAdminClient();
  return withAudit(
    actor,
    { action: "school.signing_key.add", schoolId: school, details: { public_key: key } },
    async () => ({
      id: (await rpc(admin, "add_school_signing_key", {
        p_school: school,
        p_public_key: key,
        p_by: actor.email,
      })) as string,
    })
  );
}

export async function revokeSigningKey(keyId: string): Promise<void> {
  const actor = await requireActor(OWNER);
  const id = z.string().uuid().parse(keyId);
  const admin = createAdminClient();
  const { data } = await admin
    .from("school_signing_keys")
    .select("school_id, public_key")
    .eq("id", id)
    .maybeSingle();
  if (!data) throw new Error("That key does not exist.");
  await withAudit(
    actor,
    {
      action: "school.signing_key.revoke",
      schoolId: data.school_id as string,
      details: { public_key: data.public_key },
    },
    () => rpc(admin, "revoke_school_signing_key", { p_key: id })
  );
}
