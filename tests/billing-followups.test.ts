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
  REFUND_WINDOW_DAYS,
  cancelTopup,
  createTopup,
  markTopupPaid,
  refundInvoice,
} from "@/lib/actions/billing";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const SCHOOL = uuid(10);
const SUB = uuid(20);
const TOPUP = uuid(50);
const owner = { id: uuid(1), email: "owner@example.com", role: "owner" };
const finance = { id: uuid(2), email: "finance@example.com", role: "finance" };
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
    price_catalog: [price("base_fee", 15_000_000), price("extra_student", 100_000)],
    school_price_overrides: [],
    subscriptions: [
      { id: SUB, school_id: SCHOOL, reference: "SUB-0A1B2C3D", session: "2026/2027" },
    ],
    subscription_topups: [{ id: TOPUP, school_id: SCHOOL, reference: "TOP-0A1B2C3D" }],
  };
});

describe("createTopup", () => {
  it("prices the students at today's extra-student price, audits, then calls the database", async () => {
    expect(await createTopup(SUB, "5")).toEqual({ id: "result-id", totalKobo: 500_000 });
    expect(order).toEqual(["audit", "rpc:create_topup"]);
    expect(audited[0]).toMatchObject({
      action: "topup.create",
      schoolId: SCHOOL,
      details: {
        reference: "SUB-0A1B2C3D",
        extra_students: 5,
        total_kobo: 500_000,
        unit_kobo: 100_000,
      },
    });
    const args = mocks.rpc.mock.calls[0][1];
    expect(args).toMatchObject({
      p_sub: SUB,
      p_extra: 5,
      p_amount: 500_000,
      p_by: "finance@example.com",
    });
    expect(args.p_line).toMatchObject({ item: "extra_student", unit_kobo: 100_000, quantity: 5 });
  });

  it("applies the school's override for that session, and says so in the audit row", async () => {
    mocks.tables.school_price_overrides = [
      {
        school_id: SCHOOL,
        item: "extra_student",
        session: "2026/2027",
        amount_kobo: null,
        percent_off: 50,
        reason: "founding school",
        created_at: "2026-02-01T00:00:00Z",
      },
    ];
    expect((await createTopup(SUB, 4)).totalKobo).toBe(200_000);
    expect(audited[0].details).toMatchObject({ unit_kobo: 50_000, override: "percent" });
  });

  it("ignores an override for another session", async () => {
    mocks.tables.school_price_overrides = [
      {
        school_id: SCHOOL,
        item: "extra_student",
        session: "2025/2026",
        amount_kobo: 1,
        percent_off: null,
        reason: "old",
        created_at: "2026-02-01T00:00:00Z",
      },
    ];
    expect((await createTopup(SUB, 1)).totalKobo).toBe(100_000);
  });

  it("refuses bad counts before anything is audited", async () => {
    for (const bad of ["0", "-3", "2.5", "", "abc", "100001"]) {
      await expect(createTopup(SUB, bad)).rejects.toThrow();
    }
    expect(audited).toEqual([]);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("says so when no extra-student price is set, and for an unknown invoice", async () => {
    mocks.tables.price_catalog = [price("base_fee", 15_000_000)];
    await expect(createTopup(SUB, 3)).rejects.toThrow(/No price is set for: Extra students/);
    await expect(createTopup(uuid(99), 3)).rejects.toThrow("That invoice does not exist.");
    expect(audited).toEqual([]);
  });

  it("passes the database's refusal through as it is worded", async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: null,
      error: { message: "A top-up needs a paid invoice; this one is pending." },
    });
    await expect(createTopup(SUB, 3)).rejects.toThrow("A top-up needs a paid invoice");
  });
});

describe("cancelTopup and markTopupPaid", () => {
  it("cancel needs a reason and is audited first", async () => {
    await expect(cancelTopup(TOPUP, " ")).rejects.toThrow();
    await cancelTopup(TOPUP, "asked in error");
    expect(order).toEqual(["audit", "rpc:cancel_topup"]);
    expect(audited[0]).toMatchObject({ action: "topup.cancel", schoolId: SCHOOL });
  });

  it("mark paid parses naira exactly into kobo and sends who and why", async () => {
    await markTopupPaid(TOPUP, "5,000.50", " NIP9 ", "on the statement");
    expect(mocks.rpc).toHaveBeenCalledWith("mark_topup_paid", {
      p_topup: TOPUP,
      p_amount_kobo: 500_050,
      p_ref: "NIP9",
      p_by: "finance@example.com",
      p_reason: "on the statement",
    });
    expect(audited[0]).toMatchObject({
      action: "topup.mark_paid",
      details: { amount_kobo: 500_050 },
    });
    expect(order).toEqual(["audit", "rpc:mark_topup_paid"]);
  });

  it("mark paid refuses a missing reason, a bad amount or an unknown top-up, with nothing audited", async () => {
    await expect(markTopupPaid(TOPUP, "5000", "", "")).rejects.toThrow();
    await expect(markTopupPaid(TOPUP, "five", "", "x")).rejects.toThrow();
    await expect(markTopupPaid(uuid(98), "5000", "", "x")).rejects.toThrow(
      "That top-up does not exist."
    );
    expect(audited).toEqual([]);
  });
});

describe("refundInvoice", () => {
  it("is for the owner only", async () => {
    mocks.requireActor.mockResolvedValue(owner);
    await refundInvoice(SUB, "closed", "REFUND");
    expect(JSON.stringify(mocks.requireActor.mock.calls[0][0])).toBe('["owner"]');
  });

  it("needs a reason and the typed word, and does nothing without them", async () => {
    await expect(refundInvoice(SUB, "", "REFUND")).rejects.toThrow();
    await expect(refundInvoice(SUB, "closed", "refund")).rejects.toThrow("Type REFUND to confirm.");
    await expect(refundInvoice(SUB, "closed", undefined)).rejects.toThrow(
      "Type REFUND to confirm."
    );
    expect(audited).toEqual([]);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("audits first, passes the window, and returns the amount the database refunded", async () => {
    mocks.rpc.mockImplementationOnce(
      async (name: string) => (
        order.push(`rpc:${name}`),
        {
          data: 15_200_000,
          error: null,
        }
      )
    );
    expect(await refundInvoice(SUB, "school closed", "REFUND")).toEqual({ refundKobo: 15_200_000 });
    expect(order).toEqual(["audit", "rpc:refund_subscription"]);
    expect(mocks.rpc).toHaveBeenCalledWith("refund_subscription", {
      p_sub: SUB,
      p_by: "finance@example.com",
      p_reason: "school closed",
      p_window_days: REFUND_WINDOW_DAYS,
    });
    expect(audited[0]).toMatchObject({
      action: "subscription.refund",
      schoolId: SCHOOL,
      details: { reference: "SUB-0A1B2C3D", reason: "school closed", window_days: 14 },
    });
  });

  it("passes the window refusal through", async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: null,
      error: {
        message: "This invoice was paid more than 14 days ago, so it is outside the refund window.",
      },
    });
    await expect(refundInvoice(SUB, "late", "REFUND")).rejects.toThrow("outside the refund window");
  });
});
