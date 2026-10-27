import { describe, expect, it } from "vitest";
import { pdfMoney, pdfText, renderDocumentPdf, wrap, type DocumentModel } from "@/lib/billing/pdf";

const model = (over: Partial<DocumentModel> = {}): DocumentModel => ({
  kind: "invoice",
  number: "SUB-0A1B2C3D",
  issuedOn: "2026-10-26",
  issuer: { name: "Acme Schools Ltd", lines: ["12 Example Road", "Bank 0123456789"] },
  school: { name: "Greenfield Academy" },
  session: "2026/2027",
  validUntil: "2027-07-31",
  reference: "SUB-0A1B2C3D",
  lines: [{ description: "Base fee", quantity: 1, unitKobo: 15_000_000, totalKobo: 15_000_000 }],
  totalKobo: 15_000_000,
  ...over,
});
const text = (pdf: Buffer) => pdf.toString("latin1");

describe("pdfMoney", () => {
  it("writes whole kobo as NGN with separators and two decimals", () => {
    expect(pdfMoney(15_000_000)).toBe("NGN 150,000.00");
    expect(pdfMoney(5)).toBe("NGN 0.05");
    expect(pdfMoney(0)).toBe("NGN 0.00");
    expect(pdfMoney(123_456_789)).toBe("NGN 1,234,567.89");
    expect(pdfMoney(-250)).toBe("-NGN 2.50");
  });
  it("shows a question mark instead of guessing for an impossible amount", () => {
    expect(pdfMoney(1.5)).toBe("NGN ?");
    expect(pdfMoney(Number.NaN)).toBe("NGN ?");
  });
});

describe("pdfText", () => {
  it("keeps Latin-1, maps common punctuation and the naira sign, and blanks the rest", () => {
    expect(pdfText("Caf\u00e9 \u2013 \u201cquoted\u201d \u20a65")).toBe(
      'Caf\u00e9 - "quoted" NGN 5'
    );
    expect(pdfText("tab\there\u0000 \u4e2d")).toBe("tab?here? ?");
  });
});

describe("wrap", () => {
  it("breaks at spaces within the width and never loses a word", () => {
    const lines = wrap("one two three four five six seven eight nine ten", 10, 80);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join(" ")).toBe("one two three four five six seven eight nine ten");
  });
  it("splits a single word that is wider than the line", () => {
    const lines = wrap("A".repeat(60), 10, 100);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join("")).toBe("A".repeat(60));
  });
  it("returns one empty line for empty text", () => {
    expect(wrap("", 10, 100)).toEqual([""]);
  });
});

describe("renderDocumentPdf", () => {
  it("makes a PDF whose cross-reference offsets point at the objects", () => {
    const pdf = renderDocumentPdf(model());
    const s = text(pdf);
    expect(s.startsWith("%PDF-1.4\n")).toBe(true);
    expect(s.trimEnd().endsWith("%%EOF")).toBe(true);
    const start = Number(/startxref\n(\d+)\n/.exec(s)![1]);
    expect(s.slice(start, start + 4)).toBe("xref");
    const entries = [...s.slice(start).matchAll(/(\d{10}) 00000 n /g)].map((m) => Number(m[1]));
    expect(entries.length).toBeGreaterThanOrEqual(7);
    entries.forEach((offset, i) => {
      expect(s.slice(offset, offset + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`);
    });
  });

  it("states the declared stream lengths correctly", () => {
    const s = text(renderDocumentPdf(model()));
    for (const m of s.matchAll(/\/Length (\d+) >>\nstream\n([\s\S]*?)\nendstream/g)) {
      expect(Buffer.byteLength(m[2], "latin1")).toBe(Number(m[1]));
    }
  });

  it("shows an invoice's payment instructions with the reference, and no payment section", () => {
    const s = text(renderDocumentPdf(model()));
    expect(s).toContain("(INVOICE)");
    expect(s).toContain("How to pay");
    expect(s).toContain("SUB-0A1B2C3D");
    expect(s).toContain("(NGN 150,000.00)");
    expect(s).not.toContain("(Payment)");
    expect(s).not.toContain("REFUNDED");
  });

  it("shows a receipt's payment, and a refund notice when refunded", () => {
    const paid = text(
      renderDocumentPdf(
        model({
          kind: "receipt",
          number: "RCT-0A1B2C3D",
          payment: { method: "bank transfer", reference: "NIP123", paidOn: "2026-10-25" },
        })
      )
    );
    expect(paid).toContain("(RECEIPT)");
    expect(paid).toContain("NIP123");
    expect(paid).not.toContain("How to pay");
    const refunded = text(
      renderDocumentPdf(
        model({
          kind: "receipt",
          payment: { method: "bank transfer", reference: "NIP123", paidOn: "2026-10-25" },
          refund: { onDate: "2026-10-27", amountKobo: 15_000_000 },
        })
      )
    );
    expect(refunded).toContain("REFUNDED on 2026-10-27");
  });

  it("cannot be broken by brackets, backslashes or odd characters in what a person typed", () => {
    const s = text(
      renderDocumentPdf(
        model({
          school: { name: "St. Mary) (Girls\\ \u4e2d" },
          lines: [{ description: ") BT (evil", quantity: 1, unitKobo: 1, totalKobo: 1 }],
          totalKobo: 1,
        })
      )
    );
    expect(s).toContain("St. Mary\\) \\(Girls\\\\ ?");
    expect(s).toContain("\\) BT \\(evil");
    expect(s).not.toMatch(/[^\x00-\xff]/);
  });

  it("starts a new page when there are many lines", () => {
    const lines = Array.from({ length: 80 }, (_, i) => ({
      description: `Add-on: feature_${i}`,
      quantity: 1,
      unitKobo: 100,
      totalKobo: 100,
    }));
    const s = text(renderDocumentPdf(model({ lines, totalKobo: 8000 })));
    const count = Number(/\/Type \/Pages \/Kids \[[^\]]*\] \/Count (\d+)/.exec(s)![1]);
    expect(count).toBeGreaterThan(1);
    expect(s).toContain("feature_79");
  });

  it("is the same bytes for the same document", () => {
    expect(renderDocumentPdf(model()).equals(renderDocumentPdf(model()))).toBe(true);
  });
});
