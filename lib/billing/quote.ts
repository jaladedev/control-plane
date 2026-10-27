import { formatNaira, MAX_KOBO } from "@/lib/billing/money";

// Turns the price catalog (and any overrides) into a quote. Pure: no database,
// no clock of its own. The quote records the price it used for every line, so an
// invoice made from it never changes when a price is edited later.

export type PriceRow = {
  item: string;
  amount_kobo: number | null;
  count: number | null;
  effective_from: string;
  created_at: string;
};

export type OverrideRow = {
  item: string;
  session: string;
  amount_kobo: number | null;
  percent_off: number | null;
  reason: string;
  created_at: string;
};

export type QuoteInput = {
  session: string;
  asOf: Date;
  prices: PriceRow[];
  overrides: OverrideRow[];
  /** The school's own student allowance; 0 means "use the catalog's". */
  schoolIncludedStudents: number;
  extraStudents: number;
  features: string[];
  proHosting: boolean;
};

export type QuoteLine = {
  item: string;
  label: string;
  quantity: number;
  list_unit_kobo: number;
  unit_kobo: number;
  override: { kind: "amount" | "percent"; value: number; reason: string } | null;
  total_kobo: number;
};

export type Quote = {
  session: string;
  as_of: string;
  included_students: number;
  extra_students: number;
  lines: QuoteLine[];
  total_kobo: number;
};

export class QuoteError extends Error {}

const FEATURE = /^[a-z][a-z0-9_]{1,39}$/;

/** The price in force at a moment: the latest effective one, newest entry winning a tie. */
export function priceAt(prices: PriceRow[], item: string, asOf: Date): PriceRow | null {
  const live = prices.filter(
    (p) => p.item === item && Date.parse(p.effective_from) <= asOf.getTime()
  );
  live.sort(
    (a, b) =>
      Date.parse(b.effective_from) - Date.parse(a.effective_from) ||
      Date.parse(b.created_at) - Date.parse(a.created_at)
  );
  return live[0] ?? null;
}

function overrideFor(overrides: OverrideRow[], item: string, session: string): OverrideRow | null {
  const mine = overrides.filter((o) => o.item === item && o.session === session);
  mine.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  return mine[0] ?? null;
}

// Half-up integer rounding of price * percent / 100.
const discountOf = (price: number, percent: number) => Math.floor((price * percent + 50) / 100);

const LABELS: Record<string, string> = {
  base_fee: "Base fee",
  extra_student: "Extra students",
  pro_hosting: "Pro hosting",
  included_students: "Included students",
};
export const itemLabel = (item: string) =>
  item.startsWith("feature:") ? `Add-on: ${item.slice(8)}` : (LABELS[item] ?? item);

/** One priced line: the list price, any override for this session, and the total. */
export function priceLine(
  prices: PriceRow[],
  overrides: OverrideRow[],
  item: string,
  session: string,
  asOf: Date,
  quantity: number,
  label = itemLabel(item)
): QuoteLine {
  const list = priceAt(prices, item, asOf)!.amount_kobo ?? 0;
  const o = overrideFor(overrides, item, session);
  let unit = list;
  let override: QuoteLine["override"] = null;
  if (o) {
    if (o.amount_kobo !== null) {
      unit = o.amount_kobo;
      override = { kind: "amount", value: o.amount_kobo, reason: o.reason };
    } else if (o.percent_off !== null) {
      unit = list - discountOf(list, o.percent_off);
      override = { kind: "percent", value: o.percent_off, reason: o.reason };
    }
  }
  return {
    item,
    label,
    quantity,
    list_unit_kobo: list,
    unit_kobo: unit,
    override,
    total_kobo: unit * quantity,
  };
}

/**
 * The price of adding students to a session that is already paid: the extra-student
 * price in force today, with the school's override for that session if it has one.
 */
export function buildTopupLine(input: {
  session: string;
  asOf: Date;
  prices: PriceRow[];
  overrides: OverrideRow[];
  extraStudents: number;
}): QuoteLine {
  const n = input.extraStudents;
  if (!Number.isInteger(n) || n < 1 || n > 100_000) {
    throw new QuoteError("Extra students must be a whole number from 1 to 100,000.");
  }
  if (!priceAt(input.prices, "extra_student", input.asOf)) {
    throw new QuoteError("No price is set for: Extra students. Set it on the Prices screen first.");
  }
  const line = priceLine(
    input.prices,
    input.overrides,
    "extra_student",
    input.session,
    input.asOf,
    n,
    `Extra students (${n})`
  );
  if (!Number.isSafeInteger(line.total_kobo) || line.total_kobo > MAX_KOBO) {
    throw new QuoteError("The total is too large; check the quantity.");
  }
  return line;
}

export function buildQuote(input: QuoteInput): Quote {
  const { session, asOf, prices, overrides } = input;
  if (!session.trim()) throw new QuoteError("Enter the academic session (for example 2026/2027).");
  if (
    !Number.isInteger(input.extraStudents) ||
    input.extraStudents < 0 ||
    input.extraStudents > 100_000
  ) {
    throw new QuoteError("Extra students must be a whole number from 0 to 100,000.");
  }
  const features = [
    ...new Set(input.features.map((f) => f.trim().toLowerCase()).filter(Boolean)),
  ].sort();
  const badFeature = features.find((f) => !FEATURE.test(f));
  if (badFeature)
    throw new QuoteError(
      `Add-on "${badFeature}" is not valid (lowercase letters, digits and underscores).`
    );

  const needed = ["base_fee"];
  if (input.extraStudents > 0) needed.push("extra_student");
  if (input.proHosting) needed.push("pro_hosting");
  for (const f of features) needed.push(`feature:${f}`);
  if (input.schoolIncludedStudents <= 0) needed.push("included_students");
  const missing = needed.filter((item) => !priceAt(prices, item, asOf));
  if (missing.length > 0) {
    throw new QuoteError(
      `No price is set for: ${missing.map(itemLabel).join(", ")}. Set them on the Prices screen first.`
    );
  }

  const included =
    input.schoolIncludedStudents > 0
      ? input.schoolIncludedStudents
      : (priceAt(prices, "included_students", asOf)!.count ?? 0);

  const line = (item: string, quantity: number, label = itemLabel(item)): QuoteLine =>
    priceLine(prices, overrides, item, session, asOf, quantity, label);

  const lines: QuoteLine[] = [line("base_fee", 1)];
  if (input.extraStudents > 0) {
    lines.push(
      line("extra_student", input.extraStudents, `Extra students (${input.extraStudents})`)
    );
  }
  if (input.proHosting) lines.push(line("pro_hosting", 1));
  for (const f of features) lines.push(line(`feature:${f}`, 1));

  const total = lines.reduce((sum, l) => sum + l.total_kobo, 0);
  if (!Number.isSafeInteger(total) || total > MAX_KOBO)
    throw new QuoteError("The total is too large; check the quantities.");
  return {
    session: session.trim(),
    as_of: asOf.toISOString(),
    included_students: included,
    extra_students: input.extraStudents,
    lines,
    total_kobo: total,
  };
}

/** The add-on lines the database stores on the invoice. */
export const featureItems = (q: Quote) =>
  q.lines
    .filter((l) => l.item.startsWith("feature:"))
    .map((l) => ({ feature: l.item.slice(8), amount_kobo: l.total_kobo }));

export const describeQuoteLine = (l: QuoteLine) =>
  `${l.label}: ${formatNaira(l.total_kobo)}${l.override ? " (override)" : ""}`;
