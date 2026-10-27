import { Buffer } from "node:buffer";
import { MAX_KOBO } from "@/lib/billing/money";

// A small, dependency-free PDF writer for one kind of page: an invoice or receipt.
// Helvetica is built into every PDF reader, so nothing is embedded; that also means
// only Latin-1 text can be shown, and the naira sign is written as "NGN".

export type DocumentLine = {
  description: string;
  quantity: number;
  unitKobo: number;
  totalKobo: number;
};

export type DocumentModel = {
  kind: "invoice" | "receipt";
  number: string;
  issuedOn: string; // YYYY-MM-DD
  issuer: { name: string; lines: string[] };
  school: { name: string };
  session: string;
  validUntil: string; // YYYY-MM-DD
  /** What the payer writes on a transfer. */
  reference: string;
  lines: DocumentLine[];
  totalKobo: number;
  payment?: { method: string; reference: string; paidOn: string };
  refund?: { onDate: string; amountKobo: number };
};

/** "NGN 150,000.00": whole kobo in, no floating point. */
export function pdfMoney(kobo: number): string {
  if (!Number.isSafeInteger(kobo) || Math.abs(kobo) > MAX_KOBO * 10) return "NGN ?";
  const sign = kobo < 0 ? "-" : "";
  const abs = Math.abs(kobo);
  const whole = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}NGN ${whole}.${String(abs % 100).padStart(2, "0")}`;
}

// Helvetica widths (1/1000 em) for 0x20 to 0x7E, from the standard AFM.
const W = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556,
  556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667,
  611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667,
  667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500,
  222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];

const REPLACEMENTS: Record<string, string> = {
  "\u2018": "'",
  "\u2019": "'",
  "\u201c": '"',
  "\u201d": '"',
  "\u2013": "-",
  "\u2014": "-",
  "\u2026": "...",
  "\u20a6": "NGN ",
};

/** Text the page can show: Latin-1 only, no control characters, nothing that breaks a string. */
export function pdfText(input: string): string {
  let out = "";
  for (const ch of input.replace(
    /[\u2018\u2019\u201c\u201d\u2013\u2014\u2026\u20a6]/g,
    (c) => REPLACEMENTS[c]
  )) {
    const code = ch.codePointAt(0)!;
    out += (code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff) ? ch : "?";
  }
  return out;
}

const textWidth = (text: string, size: number) =>
  (Array.from(text).reduce((sum, ch) => {
    const c = ch.charCodeAt(0);
    return sum + (c >= 0x20 && c <= 0x7e ? W[c - 0x20] : 556);
  }, 0) *
    size) /
  1000;

const escape = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`);

const PAGE_W = 595; // A4 in points
const PAGE_H = 842;
const MARGIN = 50;

type Align = "left" | "right";

class Page {
  ops: string[] = [];
  text(
    x: number,
    y: number,
    s: string,
    size: number,
    opts: { bold?: boolean; align?: Align } = {}
  ) {
    const t = pdfText(s);
    const left = opts.align === "right" ? x - textWidth(t, size) : x;
    this.ops.push(
      `BT /${opts.bold ? "F2" : "F1"} ${size} Tf ${left.toFixed(2)} ${y.toFixed(2)} Td (${escape(t)}) Tj ET`
    );
  }
  rule(y: number, width = 0.5) {
    this.ops.push(`${width} w ${MARGIN} ${y.toFixed(2)} m ${PAGE_W - MARGIN} ${y.toFixed(2)} l S`);
  }
}

/** Cuts text into lines no wider than `width`, breaking at spaces (and inside a very long word). */
export function wrap(text: string, size: number, width: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of pdfText(text).split(/\s+/).filter(Boolean)) {
    let w = word;
    while (textWidth(w, size) > width) {
      let cut = w.length - 1;
      while (cut > 1 && textWidth(w.slice(0, cut), size) > width) cut--;
      if (line) (out.push(line), (line = ""));
      out.push(w.slice(0, cut));
      w = w.slice(cut);
    }
    const next = line ? `${line} ${w}` : w;
    if (textWidth(next, size) > width && line) {
      out.push(line);
      line = w;
    } else {
      line = next;
    }
  }
  if (line) out.push(line);
  return out.length ? out : [""];
}

export function renderDocumentPdf(doc: DocumentModel): Buffer {
  const pages: Page[] = [new Page()];
  let page = pages[0];
  let y = PAGE_H - MARGIN;
  const need = (h: number) => {
    if (y - h < MARGIN + 30) {
      page = new Page();
      pages.push(page);
      y = PAGE_H - MARGIN;
    }
  };
  const right = PAGE_W - MARGIN;

  page.text(MARGIN, y, doc.kind === "receipt" ? "RECEIPT" : "INVOICE", 22, { bold: true });
  page.text(right, y, doc.issuer.name || "", 13, { bold: true, align: "right" });
  y -= 18;
  for (const l of doc.issuer.lines) {
    page.text(right, y, l, 9, { align: "right" });
    y -= 12;
  }
  y = Math.min(y, PAGE_H - MARGIN - 40);
  y -= 10;
  page.rule(y);
  y -= 22;

  const meta: [string, string][] = [
    [doc.kind === "receipt" ? "Receipt no." : "Invoice no.", doc.number],
    ["Date", doc.issuedOn],
    ["Billed to", doc.school.name],
    ["Session", doc.session],
    ["Valid until", doc.validUntil],
  ];
  for (const [k, v] of meta) {
    page.text(MARGIN, y, k, 10);
    const lines = wrap(v, 10, 340);
    for (const [i, l] of lines.entries())
      page.text(MARGIN + 120, y - i * 13, l, 10, { bold: true });
    y -= 16 + (lines.length - 1) * 13;
  }
  y -= 10;

  const col = { desc: MARGIN, qty: 360, unit: 450, total: right };
  need(30);
  page.rule(y + 14);
  page.text(col.desc, y, "Description", 10, { bold: true });
  page.text(col.qty, y, "Qty", 10, { bold: true, align: "right" });
  page.text(col.unit, y, "Unit price", 10, { bold: true, align: "right" });
  page.text(col.total, y, "Amount", 10, { bold: true, align: "right" });
  y -= 8;
  page.rule(y);
  y -= 16;
  for (const l of doc.lines) {
    const desc = wrap(l.description, 10, 290);
    need(desc.length * 13 + 6);
    for (const [i, d] of desc.entries()) page.text(col.desc, y - i * 13, d, 10);
    page.text(col.qty, y, String(l.quantity), 10, { align: "right" });
    page.text(col.unit, y, pdfMoney(l.unitKobo), 10, { align: "right" });
    page.text(col.total, y, pdfMoney(l.totalKobo), 10, { align: "right" });
    y -= desc.length * 13 + 6;
  }
  need(60);
  page.rule(y + 6);
  y -= 12;
  page.text(col.unit, y, "Total", 12, { bold: true, align: "right" });
  page.text(col.total, y, pdfMoney(doc.totalKobo), 12, { bold: true, align: "right" });
  y -= 30;

  if (doc.kind === "invoice") {
    need(70);
    page.text(MARGIN, y, "How to pay", 11, { bold: true });
    y -= 16;
    const how = [
      `Pay by bank transfer and write this reference in the narration: ${doc.reference}`,
      "Then tell us you have sent it from your school's billing screen. The licence is updated once the payment is confirmed in our bank.",
    ];
    for (const para of how) {
      for (const l of wrap(para, 10, PAGE_W - 2 * MARGIN)) {
        page.text(MARGIN, y, l, 10);
        y -= 13;
      }
      y -= 4;
    }
  }
  if (doc.payment) {
    need(60);
    page.text(MARGIN, y, "Payment", 11, { bold: true });
    y -= 16;
    for (const l of wrap(
      `Received ${pdfMoney(doc.totalKobo)} on ${doc.payment.paidOn} by ${doc.payment.method}, reference ${doc.payment.reference}. Thank you.`,
      10,
      PAGE_W - 2 * MARGIN
    )) {
      page.text(MARGIN, y, l, 10);
      y -= 13;
    }
    y -= 8;
  }
  if (doc.refund) {
    need(50);
    page.text(
      MARGIN,
      y,
      `REFUNDED on ${doc.refund.onDate}: ${pdfMoney(doc.refund.amountKobo)}`,
      12,
      {
        bold: true,
      }
    );
    y -= 16;
    page.text(MARGIN, y, "This receipt no longer entitles the school to a licence.", 10);
  }

  return assemble(pages, `${doc.kind === "receipt" ? "Receipt" : "Invoice"} ${doc.number}`);
}

function assemble(pages: Page[], title: string): Buffer {
  const objects: string[] = [];
  const add = (body: string) => objects.push(body) && objects.length;
  const catalog = add("<< /Type /Catalog /Pages 2 0 R >>");
  const pagesObj = add("");
  const f1 = add(
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"
  );
  const f2 = add(
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>"
  );
  const info = add(`<< /Title (${escape(pdfText(title))}) /Producer (control-plane) >>`);
  const kids: number[] = [];
  for (const p of pages) {
    const stream = p.ops.join("\n");
    const content = add(
      `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`
    );
    kids.push(
      add(
        `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${content} 0 R >>`
      )
    );
  }
  objects[pagesObj - 1] =
    `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;

  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
