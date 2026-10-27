import { describe, expect, it } from "vitest";
import {
  DocumentError,
  buildDocument,
  issuerFrom,
  type SubscriptionRow,
  type TopupRow,
} from "@/lib/billing/documents";

const sub = (over: Partial<SubscriptionRow> = {}): SubscriptionRow => ({
  reference: "SUB-0A1B2C3D",
  session: "2026/2027",
  status: "paid",
  amount_kobo: 15_100_000,
  topup_kobo: 0,
  method: "transfer",
  payment_ref: "NIP123",
  paid_at: "2026-10-25T09:30:00Z",
  valid_until: "2027-07-31T23:59:59Z",
  created_at: "2026-10-20T08:00:00Z",
  refunded_at: null,
  refund_kobo: null,
  quote: {
    session: "2026/2027",
    as_of: "2026-10-20T08:00:00Z",
    included_students: 300,
    extra_students: 0,
    total_kobo: 15_100_000,
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
      {
        item: "feature:sms_alerts",
        label: "Add-on: sms_alerts",
        quantity: 1,
        list_unit_kobo: 200_000,
        unit_kobo: 100_000,
        override: { kind: "percent", value: 50, reason: "founding school" },
        total_kobo: 100_000,
      },
    ],
  },
  ...over,
});
const topup = (over: Partial<TopupRow> = {}): TopupRow => ({
  reference: "TOP-AAAA1111",
  extra_students: 5,
  amount_kobo: 500_000,
  status: "paid",
  paid_at: "2026-11-02T10:00:00Z",
  line: { unit_kobo: 100_000 },
  ...over,
});
const school = { name: "Greenfield Academy" };
const issuer = { name: "Acme", lines: [] };

describe("buildDocument", () => {
  it("makes a receipt for a paid invoice, dated by payment, with the override shown", () => {
    const doc = buildDocument(sub(), [], school, issuer);
    expect(doc).toMatchObject({
      kind: "receipt",
      number: "RCT-0A1B2C3D",
      issuedOn: "2026-10-25",
      validUntil: "2027-07-31",
      reference: "SUB-0A1B2C3D",
      totalKobo: 15_100_000,
      payment: { method: "bank transfer", reference: "NIP123", paidOn: "2026-10-25" },
    });
    expect(doc.refund).toBeUndefined();
    expect(doc.lines[1].description).toBe("Add-on: sms_alerts (50% off list)");
  });

  it("makes an invoice, dated by creation, for one waiting for payment or confirmation", () => {
    for (const status of ["pending", "pending_confirmation"]) {
      const doc = buildDocument(
        sub({ status, paid_at: null, method: null, payment_ref: null }),
        [],
        school,
        issuer
      );
      expect(doc).toMatchObject({
        kind: "invoice",
        number: "SUB-0A1B2C3D",
        issuedOn: "2026-10-20",
      });
      expect(doc.payment).toBeUndefined();
    }
  });

  it("adds paid top-ups to a receipt, not unpaid or cancelled ones, and not to an invoice", () => {
    const topups = [
      topup(),
      topup({ reference: "TOP-BBBB2222", status: "pending", paid_at: null }),
      topup({ reference: "TOP-CCCC3333", status: "cancelled", paid_at: null }),
    ];
    const receipt = buildDocument(sub({ topup_kobo: 500_000 }), topups, school, issuer);
    expect(receipt.totalKobo).toBe(15_600_000);
    expect(receipt.lines.at(-1)).toMatchObject({
      description: "Top-up TOP-AAAA1111: 5 extra students",
      quantity: 5,
      unitKobo: 100_000,
      totalKobo: 500_000,
    });
    const inv = buildDocument(sub({ status: "pending", paid_at: null }), topups, school, issuer);
    expect(inv.totalKobo).toBe(15_100_000);
  });

  it("shows a refund on the receipt of a refunded invoice, top-ups included", () => {
    const doc = buildDocument(
      sub({
        status: "refunded",
        topup_kobo: 500_000,
        refunded_at: "2026-11-05T00:00:00Z",
        refund_kobo: 15_600_000,
      }),
      [topup({ status: "refunded" })],
      school,
      issuer
    );
    expect(doc.kind).toBe("receipt");
    expect(doc.refund).toEqual({ onDate: "2026-11-05", amountKobo: 15_600_000 });
  });

  it("refuses a cancelled invoice and any status it does not know", () => {
    expect(() => buildDocument(sub({ status: "cancelled" }), [], school, issuer)).toThrow(
      "A cancelled invoice has no document."
    );
    expect(() => buildDocument(sub({ status: "trial" }), [], school, issuer)).toThrow(
      DocumentError
    );
  });

  it("refuses to print lines that do not add up to the invoice total", () => {
    expect(() => buildDocument(sub({ amount_kobo: 15_100_001 }), [], school, issuer)).toThrow(
      /do not add up/
    );
    expect(() => buildDocument(sub({ topup_kobo: 500_000 }), [], school, issuer)).toThrow(
      /do not add up/
    );
  });

  it("refuses a paid invoice with no payment date", () => {
    expect(() => buildDocument(sub({ paid_at: null }), [], school, issuer)).toThrow(DocumentError);
  });

  it("reads bigint columns that arrive as strings", () => {
    const doc = buildDocument(
      sub({ amount_kobo: "15100000", topup_kobo: "0" }),
      [],
      school,
      issuer
    );
    expect(doc.totalKobo).toBe(15_100_000);
  });
});

describe("issuerFrom", () => {
  it("splits lines on a bar, trims, drops blanks and caps at six", () => {
    expect(issuerFrom({ name: " Acme ", lines: " 12 Road | | Bank 123 |" })).toEqual({
      name: "Acme",
      lines: ["12 Road", "Bank 123"],
    });
    expect(issuerFrom({ lines: "1|2|3|4|5|6|7|8" }).lines).toHaveLength(6);
    expect(issuerFrom({})).toEqual({ name: "", lines: [] });
  });
});
