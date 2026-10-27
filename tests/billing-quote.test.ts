import { describe, expect, it } from "vitest";
import {
  QuoteError,
  buildQuote,
  featureItems,
  priceAt,
  type OverrideRow,
  type PriceRow,
} from "@/lib/billing/quote";

const ASOF = new Date("2026-10-25T12:00:00Z");
const price = (
  item: string,
  amount: number | null,
  effective = "2026-01-01T00:00:00Z",
  created = effective,
  count: number | null = null
): PriceRow => ({
  item,
  amount_kobo: amount,
  count,
  effective_from: effective,
  created_at: created,
});
const catalog: PriceRow[] = [
  price("base_fee", 15_000_000),
  price("included_students", null, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z", 300),
  price("extra_student", 5_000),
  price("pro_hosting", 4_000_000),
  price("feature:sms_alerts", 500_000),
  price("feature:parent_app", 750_000),
];
const base = {
  session: "2026/2027",
  asOf: ASOF,
  prices: catalog,
  overrides: [] as OverrideRow[],
  schoolIncludedStudents: 0,
  extraStudents: 0,
  features: [] as string[],
  proHosting: false,
};
const override = (p: Partial<OverrideRow>): OverrideRow => ({
  item: "base_fee",
  session: "2026/2027",
  amount_kobo: null,
  percent_off: null,
  reason: "agreed",
  created_at: "2026-09-01T00:00:00Z",
  ...p,
});

describe("priceAt", () => {
  it("uses the latest price already in force, and ignores future ones", () => {
    const prices = [
      price("base_fee", 100, "2026-01-01T00:00:00Z"),
      price("base_fee", 200, "2026-06-01T00:00:00Z"),
      price("base_fee", 300, "2027-01-01T00:00:00Z"),
    ];
    expect(priceAt(prices, "base_fee", ASOF)?.amount_kobo).toBe(200);
    expect(priceAt(prices, "base_fee", new Date("2025-01-01"))).toBeNull();
    expect(priceAt(prices, "base_fee", new Date("2027-06-01"))?.amount_kobo).toBe(300);
  });
  it("lets the newest entry win when two share an effective date", () => {
    const prices = [
      price("base_fee", 100, "2026-01-01T00:00:00Z", "2026-01-01T08:00:00Z"),
      price("base_fee", 150, "2026-01-01T00:00:00Z", "2026-01-01T09:00:00Z"),
    ];
    expect(priceAt(prices, "base_fee", ASOF)?.amount_kobo).toBe(150);
  });
});

describe("buildQuote", () => {
  it("is the base fee alone for a school within its allowance", () => {
    const q = buildQuote(base);
    expect(q.total_kobo).toBe(15_000_000);
    expect(q.lines).toHaveLength(1);
    expect(q.included_students).toBe(300);
    expect(q.session).toBe("2026/2027");
  });

  it("adds extra students, pro hosting and add-ons, in a stable order", () => {
    const q = buildQuote({
      ...base,
      extraStudents: 20,
      proHosting: true,
      features: ["sms_alerts", "parent_app"],
    });
    expect(q.lines.map((l) => l.item)).toEqual([
      "base_fee",
      "extra_student",
      "pro_hosting",
      "feature:parent_app",
      "feature:sms_alerts",
    ]);
    expect(q.total_kobo).toBe(15_000_000 + 20 * 5_000 + 4_000_000 + 750_000 + 500_000);
    expect(q.lines[1]).toMatchObject({ quantity: 20, unit_kobo: 5_000, total_kobo: 100_000 });
    expect(q.total_kobo).toBe(q.lines.reduce((s, l) => s + l.total_kobo, 0));
    expect(featureItems(q)).toEqual([
      { feature: "parent_app", amount_kobo: 750_000 },
      { feature: "sms_alerts", amount_kobo: 500_000 },
    ]);
  });

  it("uses the school's own allowance when it has one", () => {
    expect(buildQuote({ ...base, schoolIncludedStudents: 450 }).included_students).toBe(450);
  });

  it("de-duplicates and normalises add-ons", () => {
    const q = buildQuote({ ...base, features: ["SMS_alerts", " sms_alerts ", ""] });
    expect(q.lines.filter((l) => l.item === "feature:sms_alerts")).toHaveLength(1);
  });

  it("freezes the prices in force on the day, so a later price change cannot alter it", () => {
    const later = [...catalog, price("base_fee", 99_000_000, "2026-12-01T00:00:00Z")];
    expect(buildQuote({ ...base, prices: later }).total_kobo).toBe(15_000_000);
    expect(
      buildQuote({ ...base, prices: later, asOf: new Date("2026-12-02T00:00:00Z") }).total_kobo
    ).toBe(99_000_000);
  });

  describe("overrides", () => {
    it("a fixed price replaces the list price, and the line records both", () => {
      const q = buildQuote({ ...base, overrides: [override({ amount_kobo: 12_000_000 })] });
      expect(q.total_kobo).toBe(12_000_000);
      expect(q.lines[0]).toMatchObject({
        list_unit_kobo: 15_000_000,
        unit_kobo: 12_000_000,
        override: { kind: "amount", value: 12_000_000, reason: "agreed" },
      });
    });
    it("a percentage takes that much off the unit price", () => {
      expect(buildQuote({ ...base, overrides: [override({ percent_off: 20 })] }).total_kobo).toBe(
        12_000_000
      );
    });
    it("applies a percentage to the extra-student unit price, then multiplies", () => {
      const q = buildQuote({
        ...base,
        extraStudents: 10,
        overrides: [override({ item: "extra_student", percent_off: 10 })],
      });
      expect(q.lines[1].unit_kobo).toBe(4_500);
      expect(q.lines[1].total_kobo).toBe(45_000);
    });
    it("rounds a percentage half up, in whole kobo", () => {
      const prices = [...catalog.filter((p) => p.item !== "base_fee"), price("base_fee", 1_005)];
      // 15% of 1005 = 150.75 -> 151 off -> 854
      expect(
        buildQuote({ ...base, prices, overrides: [override({ percent_off: 15 })] }).total_kobo
      ).toBe(854);
    });
    it("a 100 percent override makes it free", () => {
      expect(buildQuote({ ...base, overrides: [override({ percent_off: 100 })] }).total_kobo).toBe(
        0
      );
    });
    it("uses the newest override, only for this session and item", () => {
      const overrides = [
        override({ amount_kobo: 1, created_at: "2026-01-01T00:00:00Z" }),
        override({ amount_kobo: 13_000_000, created_at: "2026-03-01T00:00:00Z" }),
        override({ amount_kobo: 7, session: "2025/2026" }),
        override({ item: "pro_hosting", amount_kobo: 7 }),
      ];
      expect(buildQuote({ ...base, overrides }).total_kobo).toBe(13_000_000);
    });
  });

  describe("refusals", () => {
    it("names every missing price at once", () => {
      const err = (() => {
        try {
          buildQuote({
            ...base,
            prices: [],
            extraStudents: 5,
            features: ["sms_alerts"],
            proHosting: true,
          });
        } catch (e) {
          return e as Error;
        }
      })();
      expect(err).toBeInstanceOf(QuoteError);
      expect(err!.message).toMatch(
        /Base fee, Extra students, Pro hosting, Add-on: sms_alerts, Included students/
      );
      expect(err!.message).toMatch(/Prices screen/);
    });
    it("does not need the catalog allowance when the school has its own", () => {
      const prices = catalog.filter((p) => p.item !== "included_students");
      expect(() => buildQuote({ ...base, prices })).toThrow(/Included students/);
      expect(() => buildQuote({ ...base, prices, schoolIncludedStudents: 300 })).not.toThrow();
    });
    it("does not need a price for something not being sold", () => {
      expect(() =>
        buildQuote({
          ...base,
          prices: [
            price("base_fee", 1),
            price("included_students", null, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z", 1),
          ],
        })
      ).not.toThrow();
    });
    it("rejects a price that is not yet in force as missing", () => {
      expect(() =>
        buildQuote({
          ...base,
          prices: [price("base_fee", 1, "2027-01-01T00:00:00Z"), ...catalog.slice(1)],
        })
      ).toThrow(/Base fee/);
    });
    it.each([-1, 1.5, 100_001])("rejects %s extra students", (n) => {
      expect(() => buildQuote({ ...base, extraStudents: n })).toThrow(/whole number/);
    });
    it("rejects a blank session and a badly named add-on", () => {
      expect(() => buildQuote({ ...base, session: "  " })).toThrow(/session/);
      expect(() => buildQuote({ ...base, features: ["Bad Name!"] })).toThrow(/not valid/);
    });
    it("refuses a total beyond the ceiling", () => {
      const prices = [
        price("base_fee", 900_000_000_000),
        price("extra_student", 900_000_000_000),
        catalog[1],
      ];
      expect(() => buildQuote({ ...base, prices, extraStudents: 5 })).toThrow(/too large/);
    });
  });
});
