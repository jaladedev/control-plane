import { describe, expect, it, vi } from "vitest";
import {
  RECEIPTS_LIMITS,
  RECEIPT_PDF_LIMITS,
  handleReceiptPdf,
  handleReceipts,
  paidInvoiceFromRow,
  type ReceiptPdfDeps,
  type ReceiptsDeps,
} from "@/lib/billing/receipts-endpoint";
import { generateClaimKeyPair, signClaim } from "@/lib/billing/claim-signature";
import type { SubscriptionRow } from "@/lib/billing/documents";

const keys = generateClaimKeyPair();
const NOW = new Date("2026-10-25T12:00:00Z");
const TS = Math.floor(NOW.getTime() / 1000);

const auth = (status = "active") => ({
  findSchool: vi.fn(async (slug: string) =>
    slug === "greenfield" ? { id: "school-1", status } : null
  ),
  publicKeys: vi.fn(async () => [keys.publicKey]),
  rateLimit: vi.fn(async () => true),
});
const request = (raw: string, purpose: "receipts-v1" | "invoices-v1" = "receipts-v1") => ({
  slug: "greenfield",
  timestamp: String(TS),
  signature: signClaim({
    privateKey: keys.privateKey,
    slug: "greenfield",
    timestamp: TS,
    body: raw,
    purpose,
  }),
  rawBody: raw,
  ip: "203.0.113.7",
});

const sub = (over: Partial<SubscriptionRow> = {}): SubscriptionRow => ({
  reference: "SUB-0A1B2C3D",
  session: "2026/2027",
  status: "paid",
  amount_kobo: 15_000_000,
  topup_kobo: 0,
  method: "paystack",
  payment_ref: "PSK-0123456789ABCDEF",
  paid_at: "2026-10-25T09:30:00Z",
  valid_until: "2027-07-31T23:59:59Z",
  created_at: "2026-10-20T08:00:00Z",
  refunded_at: null,
  refund_kobo: null,
  quote: {
    session: "2026/2027",
    as_of: "x",
    included_students: 300,
    extra_students: 0,
    total_kobo: 15_000_000,
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
  ...over,
});

describe("paidInvoiceFromRow", () => {
  it("adds paid top-ups to the total and cuts the timestamp to a date", () => {
    expect(
      paidInvoiceFromRow({
        reference: "SUB-0A1B2C3D",
        session: "2026/2027",
        amount_kobo: "15000000",
        topup_kobo: "500000",
        status: "paid",
        paid_at: "2026-10-25T09:30:00+00:00",
        method: "transfer",
      })
    ).toEqual({
      reference: "SUB-0A1B2C3D",
      session: "2026/2027",
      totalKobo: 15_500_000,
      status: "paid",
      paidAt: "2026-10-25",
      method: "transfer",
    });
  });
});

describe("handleReceipts", () => {
  const setup = (over: Partial<ReceiptsDeps> = {}) => {
    const deps: ReceiptsDeps = {
      ...auth(),
      paidInvoices: vi.fn(async () => [
        {
          reference: "SUB-0A1B2C3D",
          session: "2026/2027",
          totalKobo: 15_000_000,
          status: "paid" as const,
          paidAt: "2026-10-25",
          method: "paystack",
        },
      ]),
      ...over,
    };
    return {
      deps,
      send: (raw = "{}", p?: "invoices-v1") => handleReceipts(request(raw, p), deps, NOW),
    };
  };

  it("lists the authenticated school's paid invoices, and only asks for that school's", async () => {
    const { deps, send } = setup();
    expect(await send()).toEqual({
      status: 200,
      body: {
        ok: true,
        receipts: [
          {
            reference: "SUB-0A1B2C3D",
            session: "2026/2027",
            total_kobo: 15_000_000,
            status: "paid",
            paid_at: "2026-10-25",
            method: "paystack",
          },
        ],
      },
    });
    expect(deps.paidInvoices).toHaveBeenCalledWith("school-1");
  });

  it("refuses another purpose's signature, an unknown field and a bad body, reading nothing", async () => {
    const { deps, send } = setup();
    expect((await send("{}", "invoices-v1")).status).toBe(401);
    expect((await send('{"school":"x"}')).status).toBe(400);
    expect((await send("nope")).status).toBe(400);
    expect(deps.paidInvoices).not.toHaveBeenCalled();
  });

  it("uses its own limits", async () => {
    const { deps, send } = setup();
    await send();
    expect(deps.rateLimit).toHaveBeenCalledWith(
      "receipts:school:school-1",
      RECEIPTS_LIMITS.perSchool.windowSeconds,
      RECEIPTS_LIMITS.perSchool.max
    );
  });
});

describe("handleReceiptPdf", () => {
  const setup = (over: Partial<ReceiptPdfDeps> = {}, status = "active") => {
    const deps: ReceiptPdfDeps = {
      ...auth(status),
      issuer: { name: "Acme Schools", lines: ["Bank 123"] },
      loadInvoice: vi.fn(async () => ({
        sub: sub(),
        topups: [],
        schoolName: "Greenfield Academy",
      })),
      audit: vi.fn(async () => {}),
      ...over,
    };
    const body = (reference = "SUB-0A1B2C3D") => JSON.stringify({ reference });
    return {
      deps,
      body,
      send: (raw = body(), p?: "invoices-v1") => handleReceiptPdf(request(raw, p), deps, NOW),
    };
  };

  it("makes the receipt PDF for the school's own paid invoice and audits it", async () => {
    const { deps, send } = setup();
    const out = await send();
    expect(out.kind).toBe("pdf");
    if (out.kind !== "pdf") return;
    expect(out.filename).toBe("RCT-0A1B2C3D.pdf");
    const text = out.pdf.toString("latin1");
    expect(text.startsWith("%PDF-")).toBe(true);
    expect(text).toContain("(RECEIPT)");
    expect(text).toContain("Greenfield Academy");
    expect(deps.loadInvoice).toHaveBeenCalledWith("school-1", "SUB-0A1B2C3D");
    expect(deps.audit).toHaveBeenCalledWith("receipt.school_download", "school-1", {
      reference: "SUB-0A1B2C3D",
    });
  });

  it("makes a receipt for a refunded invoice, showing the refund", async () => {
    const { send } = setup({
      loadInvoice: vi.fn(async () => ({
        sub: sub({
          status: "refunded",
          refunded_at: "2026-10-27T00:00:00Z",
          refund_kobo: 15_000_000,
        }),
        topups: [],
        schoolName: "Greenfield Academy",
      })),
    });
    const out = await send();
    expect(out.kind === "pdf" && out.pdf.toString("latin1")).toContain("REFUNDED on 2026-10-27");
  });

  it("will not print an unpaid or cancelled invoice as a receipt, and says nothing that tells them apart", async () => {
    for (const status of ["pending", "pending_confirmation", "cancelled"]) {
      const { deps, send } = setup({
        loadInvoice: vi.fn(async () => ({
          sub: sub({ status, paid_at: null, method: null, payment_ref: null }),
          topups: [],
          schoolName: "Greenfield Academy",
        })),
      });
      const out = await send();
      expect(out, status).toEqual({
        kind: "json",
        result: {
          status: 404,
          body: { ok: false, error: "There is no receipt for that invoice." },
        },
      });
      expect(deps.audit).not.toHaveBeenCalled();
    }
  });

  it("answers 404 for an invoice that is not this school's, which the lookup does not return", async () => {
    const { deps, send } = setup({ loadInvoice: vi.fn(async () => null) });
    const out = await send();
    expect(out.kind === "json" && out.result.status).toBe(404);
    expect(deps.audit).not.toHaveBeenCalled();
  });

  it("answers 404 when the invoice's lines do not add up, rather than printing a wrong receipt", async () => {
    const { send } = setup({
      loadInvoice: vi.fn(async () => ({
        sub: sub({ amount_kobo: 1 }),
        topups: [],
        schoolName: "Greenfield Academy",
      })),
    });
    const out = await send();
    expect(out.kind === "json" && out.result.status).toBe(404);
  });

  it("takes only a well-formed reference", async () => {
    const { deps, body, send } = setup();
    for (const raw of [
      body("sub-0a1b2c3d"),
      body("SUB-XYZ"),
      body(""),
      "{}",
      '{"reference":"SUB-0A1B2C3D","x":1}',
    ]) {
      const out = await send(raw);
      expect(out.kind === "json" && out.result.status, raw).toBe(400);
    }
    expect(deps.loadInvoice).not.toHaveBeenCalled();
  });

  it("refuses a request signed for another purpose before reading anything", async () => {
    const { deps, send } = setup();
    const out = await send(undefined, "invoices-v1");
    expect(out.kind === "json" && out.result.status).toBe(401);
    expect(deps.loadInvoice).not.toHaveBeenCalled();
  });

  it("uses its own, tighter limits", async () => {
    const { deps, send } = setup();
    await send();
    expect(deps.rateLimit).toHaveBeenCalledWith(
      "receipt-pdf:school:school-1",
      RECEIPT_PDF_LIMITS.perSchool.windowSeconds,
      RECEIPT_PDF_LIMITS.perSchool.max
    );
  });

  it("does not make the PDF when the download cannot be audited", async () => {
    const { send } = setup({
      audit: vi.fn(async () => {
        throw new Error("audit down");
      }),
    });
    await expect(send()).rejects.toThrow("audit down");
  });
});
