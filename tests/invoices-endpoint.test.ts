import { describe, expect, it, vi } from "vitest";
import {
  INVOICES_LIMITS,
  handleInvoices,
  openInvoiceFromRow,
  type InvoicesDeps,
  type OpenInvoice,
} from "@/lib/billing/invoices-endpoint";
import { generateClaimKeyPair, signClaim } from "@/lib/billing/claim-signature";

const keys = generateClaimKeyPair();
const NOW = new Date("2026-10-25T12:00:00Z");
const TS = Math.floor(NOW.getTime() / 1000);
const invoice: OpenInvoice = {
  reference: "SUB-0A1B2C3D",
  session: "2026/2027",
  amountKobo: 15_500_000,
  status: "pending",
  validUntil: "2027-07-31",
  lines: [
    { label: "Base fee", quantity: 1, totalKobo: 15_000_000 },
    { label: "Add-on: sms_alerts", quantity: 1, totalKobo: 500_000 },
  ],
};

function setup(over: Partial<InvoicesDeps> = {}, status = "active") {
  const deps: InvoicesDeps = {
    findSchool: vi.fn(async (slug: string) =>
      slug === "greenfield" ? { id: "school-1", status } : null
    ),
    publicKeys: vi.fn(async () => [keys.publicKey]),
    rateLimit: vi.fn(async () => true),
    openInvoices: vi.fn(async () => [invoice]),
    payTo: { name: "Acme Schools", lines: ["Bank 0123456789"] },
    cardEnabled: true,
    proofEnabled: false,
    ...over,
  };
  const send = (raw = "{}", purpose: "invoices-v1" | "claim-v1" = "invoices-v1") =>
    handleInvoices(
      {
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
      },
      deps,
      NOW
    );
  return { deps, send };
}

describe("handleInvoices", () => {
  it("returns the school's open invoices, who to pay and what is switched on", async () => {
    const { deps, send } = setup();
    const res = await send();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      invoices: [
        {
          reference: "SUB-0A1B2C3D",
          session: "2026/2027",
          amount_kobo: 15_500_000,
          status: "pending",
          valid_until: "2027-07-31",
          lines: [
            { label: "Base fee", quantity: 1, total_kobo: 15_000_000 },
            { label: "Add-on: sms_alerts", quantity: 1, total_kobo: 500_000 },
          ],
        },
      ],
      pay_to: { name: "Acme Schools", lines: ["Bank 0123456789"] },
      card_enabled: true,
      proof_enabled: false,
    });
    expect(deps.openInvoices).toHaveBeenCalledWith("school-1");
  });

  it("only ever asks for the authenticated school's invoices", async () => {
    const { deps, send } = setup();
    await send();
    expect(vi.mocked(deps.openInvoices).mock.calls).toEqual([["school-1"]]);
  });

  it("returns an empty list when nothing is owed", async () => {
    const { send } = setup({ openInvoices: vi.fn(async () => []) });
    expect((await send()).body.invoices).toEqual([]);
  });

  it("refuses a request signed for another purpose, and reads nothing", async () => {
    const { deps, send } = setup();
    expect((await send("{}", "claim-v1")).status).toBe(401);
    expect(deps.openInvoices).not.toHaveBeenCalled();
  });

  it("takes an empty body only", async () => {
    const { deps, send } = setup();
    expect((await send('{"school":"other"}')).status).toBe(400);
    expect((await send("nope")).status).toBe(400);
    expect(deps.openInvoices).not.toHaveBeenCalled();
  });

  it("uses its own rate limit buckets", async () => {
    const { deps, send } = setup();
    await send();
    expect(deps.rateLimit).toHaveBeenCalledWith(
      "invoices:ip:203.0.113.7",
      INVOICES_LIMITS.perAddress.windowSeconds,
      INVOICES_LIMITS.perAddress.max
    );
    expect(deps.rateLimit).toHaveBeenCalledWith(
      "invoices:school:school-1",
      INVOICES_LIMITS.perSchool.windowSeconds,
      INVOICES_LIMITS.perSchool.max
    );
  });

  it("refuses an archived school", async () => {
    expect((await setup({}, "archived").send()).status).toBe(403);
  });
});

describe("openInvoiceFromRow", () => {
  const row = {
    reference: "SUB-0A1B2C3D",
    session: "2026/2027",
    amount_kobo: "15500000",
    status: "pending_confirmation",
    valid_until: "2027-07-31T23:59:59+00:00",
    quote: { lines: [{ label: "Base fee", quantity: 1, total_kobo: 15_500_000 }] },
  };
  it("reads a database row, turning string money and a timestamp into numbers and a date", () => {
    expect(openInvoiceFromRow(row)).toEqual({
      reference: "SUB-0A1B2C3D",
      session: "2026/2027",
      amountKobo: 15_500_000,
      status: "pending_confirmation",
      validUntil: "2027-07-31",
      lines: [{ label: "Base fee", quantity: 1, totalKobo: 15_500_000 }],
    });
  });
  it("copes with a quote with no lines, and shows any other status as pending", () => {
    const r = openInvoiceFromRow({ ...row, status: "pending", quote: null });
    expect(r.lines).toEqual([]);
    expect(r.status).toBe("pending");
  });
});
