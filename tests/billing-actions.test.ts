import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireActor: vi.fn(),
  withAudit: vi.fn(),
  rpc: vi.fn(),
  tables: {} as Record<string, Record<string, unknown>[]>,
}));

vi.mock("@/lib/auth/guards", () => ({ requireActor: mocks.requireActor }));
vi.mock("@/lib/audit", () => ({ withAudit: mocks.withAudit }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => ({
    rpc: mocks.rpc,
    from: (table: string) => {
      let rows = [...(mocks.tables[table] ?? [])];
      const b: Record<string, unknown> = {
        select: () => b,
        eq: (col: string, val: unknown) => ((rows = rows.filter((r) => r[col] === val)), b),
        maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
        then: (resolve: (v: unknown) => void) => resolve({ data: rows, error: null }),
      };
      return b;
    },
  })),
}));

import {
  addSigningKey,
  cancelInvoice,
  confirmClaim,
  createInvoice,
  extendInvoice,
  markInvoicePaid,
  previewInvoice,
  rejectClaim,
  revokeSigningKey,
  setPrice,
  setPriceOverride,
} from "@/lib/actions/billing";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const SCHOOL = uuid(10);
const SUB = uuid(20);
const CLAIM = uuid(30);
const KEY = uuid(40);
const owner = { id: uuid(1), email: "owner@example.com", role: "owner" };
const finance = { id: uuid(2), email: "finance@example.com", role: "finance" };
const future = (days: number) =>
  new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
const price = (item: string, amount: number | null, count: number | null = null) => ({
  item,
  amount_kobo: amount,
  count,
  effective_from: "2026-01-01T00:00:00Z",
  created_at: "2026-01-01T00:00:00Z",
});

let audited: { action: string; schoolId?: string | null; details?: Record<string, unknown> }[];
let order: string[];

beforeEach(() => {
  mocks.requireActor.mockReset().mockResolvedValue(finance);
  audited = [];
  order = [];
  mocks.withAudit
    .mockReset()
    .mockImplementation(async (_a, entry, fn) => (audited.push(entry), order.push("audit"), fn()));
  mocks.rpc
    .mockReset()
    .mockImplementation(
      async (name: string) => (order.push(`rpc:${name}`), { data: "result-id", error: null })
    );
  mocks.tables = {
    schools: [
      {
        id: SCHOOL,
        name: "Greenfield",
        slug: "greenfield",
        status: "active",
        included_students: 0,
      },
    ],
    price_catalog: [
      price("base_fee", 15_000_000),
      price("included_students", null, 300),
      price("extra_student", 5_000),
      price("feature:sms_alerts", 500_000),
      price("pro_hosting", 4_000_000),
    ],
    school_price_overrides: [],
    subscriptions: [{ id: SUB, school_id: SCHOOL, reference: "SUB-0A1B2C3D" }],
    payment_claims: [{ id: CLAIM, school_id: SCHOOL, subscription_id: SUB }],
    school_signing_keys: [{ id: KEY, school_id: SCHOOL, public_key: "A".repeat(43) }],
  };
});

const invoice = (over: Record<string, unknown> = {}) => ({
  schoolId: SCHOOL,
  session: "2026/2027",
  validUntil: future(300),
  graceDays: "14",
  extraStudents: "20",
  features: "sms_alerts",
  proHosting: "on",
  ...over,
});

describe("who may do what", () => {
  it("billing actions ask for owner and finance; price and key actions for the owner only", async () => {
    mocks.requireActor.mockResolvedValue(owner);
    await createInvoice(invoice());
    await cancelInvoice(SUB, "wrong");
    await markInvoicePaid(SUB, "", "cash");
    await confirmClaim(CLAIM, "150000", "checked");
    await rejectClaim(CLAIM, "no");
    await extendInvoice(SUB, future(400), "14", "goodwill");
    const billing = mocks.requireActor.mock.calls.map((c) => JSON.stringify(c[0]));
    expect(billing).toEqual(Array(6).fill('["owner","finance"]'));
    mocks.requireActor.mockClear();
    await setPrice({ item: "base_fee", value: "160000", reason: "x" });
    await setPriceOverride({
      schoolId: SCHOOL,
      item: "base_fee",
      session: "2026/2027",
      kind: "percent",
      value: "10",
      reason: "x",
    });
    await addSigningKey(SCHOOL, "B".repeat(43));
    await revokeSigningKey(KEY);
    expect(mocks.requireActor.mock.calls.map((c) => JSON.stringify(c[0]))).toEqual(
      Array(4).fill('["owner"]')
    );
  });

  it("changes nothing when a role is refused", async () => {
    mocks.requireActor.mockRejectedValue(new Error("Your role cannot do this."));
    for (const call of [
      () => createInvoice(invoice()),
      () => confirmClaim(CLAIM, "1", "x"),
      () => setPrice({ item: "base_fee", value: "1", reason: "x" }),
    ]) {
      await expect(call()).rejects.toThrow(/role cannot/);
    }
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(audited).toEqual([]);
  });
});

describe("createInvoice", () => {
  it("prices it from the catalog, audits first, then makes the invoice with the frozen quote", async () => {
    expect(await createInvoice(invoice())).toEqual({ id: "result-id" });
    expect(order).toEqual(["audit", "rpc:create_subscription"]);
    const total = 15_000_000 + 20 * 5_000 + 4_000_000 + 500_000;
    const args = mocks.rpc.mock.calls[0][1];
    expect(args).toMatchObject({
      p_school: SCHOOL,
      p_session: "2026/2027",
      p_included: 300,
      p_extra: 20,
      p_amount: total,
      p_by: "finance@example.com",
    });
    expect(args.p_items).toEqual([{ feature: "sms_alerts", amount_kobo: 500_000 }]);
    expect(args.p_quote.lines.map((l: { item: string }) => l.item)).toEqual([
      "base_fee",
      "extra_student",
      "pro_hosting",
      "feature:sms_alerts",
    ]);
    expect(args.p_quote.total_kobo).toBe(total);
    expect(audited[0]).toMatchObject({
      action: "subscription.create",
      schoolId: SCHOOL,
      details: { session: "2026/2027", total_kobo: total },
    });
  });

  it("licenses to the end of the chosen day (UTC), with grace days after it", async () => {
    const day = future(300);
    await createInvoice(invoice({ validUntil: day, graceDays: "10" }));
    const args = mocks.rpc.mock.calls[0][1];
    expect(args.p_valid_until).toBe(`${day}T23:59:59.000Z`);
    expect(Date.parse(args.p_grace_until) - Date.parse(args.p_valid_until)).toBe(10 * 86_400_000);
  });

  it("applies a school's override to the quote", async () => {
    mocks.tables.school_price_overrides = [
      {
        school_id: SCHOOL,
        item: "base_fee",
        session: "2026/2027",
        amount_kobo: null,
        percent_off: 20,
        reason: "sister school",
        created_at: "2026-02-01T00:00:00Z",
      },
    ];
    await createInvoice(invoice({ extraStudents: "", features: "", proHosting: undefined }));
    expect(mocks.rpc.mock.calls[0][1].p_amount).toBe(12_000_000);
    expect(audited[0].details?.lines).toEqual([
      { item: "base_fee", total_kobo: 12_000_000, override: "percent" },
    ]);
  });

  it("uses the school's own allowance, not the catalog's, when it has one", async () => {
    mocks.tables.schools = [
      { id: SCHOOL, name: "G", slug: "g", status: "active", included_students: 450 },
    ];
    await createInvoice(invoice({ extraStudents: "0", features: "", proHosting: undefined }));
    expect(mocks.rpc.mock.calls[0][1].p_included).toBe(450);
  });

  it.each([
    [
      "a missing price",
      () => {
        mocks.tables.price_catalog = [];
      },
      /No price is set for: Base fee/,
    ],
    [
      "an inactive school",
      () => {
        mocks.tables.schools = [
          { id: SCHOOL, name: "G", slug: "g", status: "suspended", included_students: 0 },
        ];
      },
      /active school/,
    ],
    [
      "an unknown school",
      () => {
        mocks.tables.schools = [];
      },
      /does not exist/,
    ],
  ])("refuses %s before auditing anything", async (_why, setup, message) => {
    setup();
    await expect(createInvoice(invoice())).rejects.toThrow(message);
    expect(audited).toEqual([]);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("refuses a past or impossible date, a bad session and bad numbers", async () => {
    await expect(createInvoice(invoice({ validUntil: "2020-01-01" }))).rejects.toThrow(
      /in the past/
    );
    await expect(createInvoice(invoice({ validUntil: "2027-02-30" }))).rejects.toThrow(/real date/);
    await expect(createInvoice(invoice({ validUntil: "soon" }))).rejects.toThrow(/like 2027-07-31/);
    await expect(createInvoice(invoice({ session: " " }))).rejects.toThrow(/session/);
    await expect(createInvoice(invoice({ graceDays: "400" }))).rejects.toThrow();
    await expect(createInvoice(invoice({ extraStudents: "-3" }))).rejects.toThrow();
    await expect(createInvoice(invoice({ features: "Bad Name!" }))).rejects.toThrow(/not valid/);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("passes the database's refusal through (for example a second open invoice)", async () => {
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { message: "This school already has an open invoice for 2026/2027. Cancel it first." },
    });
    await expect(createInvoice(invoice())).rejects.toThrow(/already has an open invoice/);
  });

  it("previews without auditing or writing", async () => {
    const plan = await previewInvoice(invoice());
    expect(plan.quote.total_kobo).toBe(15_000_000 + 100_000 + 4_000_000 + 500_000);
    expect(plan.school.slug).toBe("greenfield");
    expect(audited).toEqual([]);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});

describe("invoice decisions", () => {
  it("audit against the school with the invoice reference and the reason, then call the database", async () => {
    await cancelInvoice(SUB, " wrong session ");
    await markInvoicePaid(SUB, " NIP-1 ", "seen in the bank");
    await extendInvoice(SUB, future(400), "", "goodwill");
    expect(audited.map((a) => a.action)).toEqual([
      "subscription.cancel",
      "subscription.mark_paid",
      "subscription.extend",
    ]);
    expect(audited.every((a) => a.schoolId === SCHOOL)).toBe(true);
    expect(audited[0].details).toEqual({ reference: "SUB-0A1B2C3D", reason: "wrong session" });
    expect(audited[1].details).toMatchObject({ payment_ref: "NIP-1" });
    expect(mocks.rpc).toHaveBeenCalledWith("mark_subscription_paid", {
      p_sub: SUB,
      p_ref: "NIP-1",
      p_by: "finance@example.com",
      p_reason: "seen in the bank",
    });
    expect(mocks.rpc.mock.calls[2][1].p_grace_until).toBeTruthy();
  });
  it("need a reason, and a real invoice, before any audit row", async () => {
    for (const call of [
      () => cancelInvoice(SUB, ""),
      () => markInvoicePaid(SUB, "", "  "),
      () => extendInvoice(SUB, future(400), "14", ""),
    ]) {
      await expect(call()).rejects.toThrow(/reason is required/);
    }
    await expect(cancelInvoice(uuid(99), "x")).rejects.toThrow(/does not exist/);
    await expect(cancelInvoice("nope", "x")).rejects.toThrow();
    expect(audited).toEqual([]);
  });
});

describe("claims", () => {
  it("confirm reads the amount in naira as exact kobo and audits who confirmed and why", async () => {
    await confirmClaim(CLAIM, "150,000.50", "statement line 41");
    expect(order).toEqual(["audit", "rpc:confirm_claim"]);
    expect(mocks.rpc).toHaveBeenCalledWith("confirm_claim", {
      p_claim: CLAIM,
      p_amount_kobo: 15_000_050,
      p_by: "finance@example.com",
      p_reason: "statement line 41",
    });
    expect(audited[0]).toMatchObject({
      action: "claim.confirm",
      schoolId: SCHOOL,
      details: { claim_id: CLAIM, amount_kobo: 15_000_050, reason: "statement line 41" },
    });
  });
  it("confirm refuses a non-amount or a missing reason before any audit row", async () => {
    await expect(confirmClaim(CLAIM, "lots", "x")).rejects.toThrow(/amount in naira/);
    await expect(confirmClaim(CLAIM, "150000", "")).rejects.toThrow(/reason is required/);
    await expect(confirmClaim(uuid(99), "150000", "x")).rejects.toThrow(/does not exist/);
    expect(audited).toEqual([]);
  });
  it("confirm passes the amount-mismatch refusal through", async () => {
    mocks.rpc.mockResolvedValue({
      data: null,
      error: {
        message: "The amount received (14000000 kobo) does not match the invoice (15000000 kobo).",
      },
    });
    await expect(confirmClaim(CLAIM, "140000", "x")).rejects.toThrow(/does not match the invoice/);
  });
  it("reject needs a reason and is audited", async () => {
    await expect(rejectClaim(CLAIM, " ")).rejects.toThrow(/reason is required/);
    await rejectClaim(CLAIM, "not on the statement");
    expect(audited[0]).toMatchObject({
      action: "claim.reject",
      details: { claim_id: CLAIM, reason: "not on the statement" },
    });
  });
});

describe("setPrice", () => {
  beforeEach(() => mocks.requireActor.mockResolvedValue(owner));
  it("sets an amount in kobo, or a count for the student allowance, and audits the change", async () => {
    await setPrice({ item: "base_fee", value: "160,000", reason: "annual review" });
    expect(mocks.rpc).toHaveBeenLastCalledWith("set_price", {
      p_item: "base_fee",
      p_amount_kobo: 16_000_000,
      p_count: null,
      p_effective_from: null,
      p_reason: "annual review",
      p_by: "owner@example.com",
    });
    expect(audited[0]).toMatchObject({
      action: "price.set",
      details: { item: "base_fee", from: 15_000_000, to: 16_000_000 },
    });
    await setPrice({ item: "included_students", value: "350", reason: "bigger bundle" });
    expect(mocks.rpc).toHaveBeenLastCalledWith(
      "set_price",
      expect.objectContaining({ p_item: "included_students", p_amount_kobo: null, p_count: 350 })
    );
  });
  it("needs CHANGE typed for a move of more than 25 percent, either way", async () => {
    await expect(setPrice({ item: "base_fee", value: "300000", reason: "x" })).rejects.toThrow(
      /changes the price by 100%.*type CHANGE/
    );
    await expect(setPrice({ item: "base_fee", value: "100000", reason: "x" })).rejects.toThrow(
      /type CHANGE/
    );
    expect(audited).toEqual([]);
    await setPrice({ item: "base_fee", value: "300000", reason: "x", confirm: "CHANGE" });
    await setPrice({ item: "base_fee", value: "187500", reason: "x" }); // exactly 25%
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
  });
  it("lets a first price for a new add-on through without a confirmation", async () => {
    await setPrice({ item: "feature:parent_app", value: "750000", reason: "new add-on" });
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });
  it("takes a future start date, never a past one", async () => {
    await setPrice({ item: "base_fee", value: "160000", reason: "x", effectiveFrom: future(30) });
    expect(mocks.rpc.mock.calls[0][1].p_effective_from).toBe(`${future(30)}T00:00:00.000Z`);
    await expect(
      setPrice({ item: "base_fee", value: "160000", reason: "x", effectiveFrom: "2020-01-01" })
    ).rejects.toThrow(/past/);
  });
  it("refuses bad input before auditing", async () => {
    await expect(setPrice({ item: "coffee", value: "1", reason: "x" })).rejects.toThrow(
      /Choose an item/
    );
    await expect(setPrice({ item: "base_fee", value: "abc", reason: "x" })).rejects.toThrow(
      /amount in naira/
    );
    await expect(setPrice({ item: "base_fee", value: "1", reason: "" })).rejects.toThrow(
      /reason is required/
    );
    await expect(
      setPrice({ item: "included_students", value: "12.5", reason: "x" })
    ).rejects.toThrow(/whole number/);
    expect(audited).toEqual([]);
  });
});

describe("overrides and signing keys", () => {
  beforeEach(() => mocks.requireActor.mockResolvedValue(owner));
  const ov = (over: Record<string, unknown> = {}) => ({
    schoolId: SCHOOL,
    item: "base_fee",
    session: "2026/2027",
    kind: "percent",
    value: "20",
    reason: "sister school",
    ...over,
  });
  it("records a percentage or a fixed price, audited against the school", async () => {
    await setPriceOverride(ov());
    expect(mocks.rpc).toHaveBeenLastCalledWith("set_price_override", {
      p_school: SCHOOL,
      p_item: "base_fee",
      p_session: "2026/2027",
      p_amount_kobo: null,
      p_percent_off: 20,
      p_reason: "sister school",
      p_by: "owner@example.com",
    });
    await setPriceOverride(ov({ kind: "amount", value: "120,000" }));
    expect(mocks.rpc).toHaveBeenLastCalledWith(
      "set_price_override",
      expect.objectContaining({ p_amount_kobo: 12_000_000, p_percent_off: null })
    );
    expect(audited[0]).toMatchObject({ action: "price.override", schoolId: SCHOOL });
  });
  it("refuses a bad percentage, the allowance, a missing reason or school", async () => {
    for (const value of ["0", "101", "12.5", "x"])
      await expect(setPriceOverride(ov({ value }))).rejects.toThrow(/1 to 100/);
    await expect(setPriceOverride(ov({ item: "included_students" }))).rejects.toThrow(
      /no override/
    );
    await expect(setPriceOverride(ov({ reason: "" }))).rejects.toThrow(/reason is required/);
    await expect(setPriceOverride(ov({ schoolId: "x" }))).rejects.toThrow(/Choose a school/);
    expect(audited).toEqual([]);
  });
  it("adds a public key in the agreed encoding and refuses anything else", async () => {
    await addSigningKey(SCHOOL, ` ${"B".repeat(43)} `);
    expect(audited[0]).toMatchObject({
      action: "school.signing_key.add",
      schoolId: SCHOOL,
      details: { public_key: "B".repeat(43) },
    });
    expect(mocks.rpc).toHaveBeenLastCalledWith("add_school_signing_key", {
      p_school: SCHOOL,
      p_public_key: "B".repeat(43),
      p_by: "owner@example.com",
    });
    for (const bad of ["short", "!".repeat(43), "", "-----BEGIN PRIVATE KEY-----"])
      await expect(addSigningKey(SCHOOL, bad)).rejects.toThrow(/43 characters/);
  });
  it("revokes a key and records which school it belonged to", async () => {
    await revokeSigningKey(KEY);
    expect(audited[0]).toMatchObject({ action: "school.signing_key.revoke", schoolId: SCHOOL });
    await expect(revokeSigningKey(uuid(99))).rejects.toThrow(/does not exist/);
  });
});
