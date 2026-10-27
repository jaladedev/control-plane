import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireActor: vi.fn(),
  writeAudit: vi.fn(),
  tables: {} as Record<string, Record<string, unknown>[]>,
}));

vi.mock("@/lib/auth/guards", () => {
  class AccessError extends Error {
    constructor(
      message: string,
      readonly code: string
    ) {
      super(message);
    }
  }
  return { AccessError, requireActor: mocks.requireActor };
});
vi.mock("@/lib/audit", () => ({ writeAudit: mocks.writeAudit }));
vi.mock("@/lib/env", () => ({
  env: { BILLING_ISSUER_NAME: "Acme Schools", BILLING_ISSUER_LINES: "12 Road|Bank 123" },
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (table: string) => {
      let rows = [...(mocks.tables[table] ?? [])];
      const b: Record<string, unknown> = {
        select: () => b,
        eq: (c: string, v: unknown) => ((rows = rows.filter((r) => r[c] === v)), b),
        maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
        then: (resolve: (v: unknown) => void) => resolve({ data: rows, error: null }),
      };
      return b;
    },
  }),
}));

import { GET } from "@/app/billing/[id]/pdf/route";
import { AccessError } from "@/lib/auth/guards";

const SUB = "00000000-0000-4000-8000-000000000020";
const SCHOOL = "00000000-0000-4000-8000-000000000010";
const call = (id: string) =>
  GET(new Request("http://x") as never, { params: Promise.resolve({ id }) });

beforeEach(() => {
  mocks.requireActor
    .mockReset()
    .mockResolvedValue({ id: "u", email: "f@example.com", role: "finance" });
  mocks.writeAudit.mockReset().mockResolvedValue(undefined);
  mocks.tables = {
    subscriptions: [
      {
        id: SUB,
        school_id: SCHOOL,
        reference: "SUB-0A1B2C3D",
        session: "2026/2027",
        status: "paid",
        amount_kobo: 15_000_000,
        topup_kobo: 0,
        method: "transfer",
        payment_ref: "NIP1",
        paid_at: "2026-10-25T09:00:00Z",
        valid_until: "2027-07-31T23:59:59Z",
        created_at: "2026-10-20T08:00:00Z",
        refunded_at: null,
        refund_kobo: null,
        quote: {
          lines: [
            {
              item: "base_fee",
              label: "Base fee",
              quantity: 1,
              list_unit_kobo: 15_000_000,
              unit_kobo: 15_000_000,
              override: null,
              total_kobo: 15_000_000,
            },
          ],
        },
      },
    ],
    schools: [{ id: SCHOOL, name: "Greenfield Academy" }],
    subscription_topups: [],
  };
});

describe("GET /billing/[id]/pdf", () => {
  it("returns the receipt as a PDF download and audits who fetched it", async () => {
    const res = await call(SUB);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="RCT-0A1B2C3D.pdf"');
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.subarray(0, 5).toString()).toBe("%PDF-");
    expect(body.toString("latin1")).toContain("Greenfield Academy");
    expect(body.toString("latin1")).toContain("Acme Schools");
    expect(mocks.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ email: "f@example.com" }),
      { action: "receipt.download", schoolId: SCHOOL, details: { reference: "SUB-0A1B2C3D" } }
    );
  });

  it("asks for owner or finance, and answers 401 or 403 without leaking anything", async () => {
    mocks.requireActor.mockRejectedValueOnce(new AccessError("Sign in first.", "signed_out"));
    expect((await call(SUB)).status).toBe(401);
    mocks.requireActor.mockRejectedValueOnce(new AccessError("Not for you.", "forbidden"));
    expect((await call(SUB)).status).toBe(403);
    expect(JSON.stringify(mocks.requireActor.mock.calls[0][0])).toBe('["owner","finance"]');
    expect(mocks.writeAudit).not.toHaveBeenCalled();
  });

  it("answers 404 for something that is not an invoice id or does not exist", async () => {
    expect((await call("not-a-uuid")).status).toBe(404);
    expect((await call("00000000-0000-4000-8000-000000000099")).status).toBe(404);
  });

  it("answers 409 for a cancelled invoice and records no download", async () => {
    mocks.tables.subscriptions[0].status = "cancelled";
    const res = await call(SUB);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ ok: false, error: "A cancelled invoice has no document." });
    expect(mocks.writeAudit).not.toHaveBeenCalled();
  });

  it("makes no document, and says why, when the audit row cannot be written", async () => {
    mocks.writeAudit.mockRejectedValueOnce(new Error("audit down"));
    const res = await call(SUB);
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).not.toBe("application/pdf");
  });
});
