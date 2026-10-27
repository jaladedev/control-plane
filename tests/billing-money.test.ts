import { describe, expect, it } from "vitest";
import { MAX_KOBO, MoneyError, formatNaira, nairaToKobo } from "@/lib/billing/money";

describe("nairaToKobo", () => {
  it.each([
    ["150000", 15_000_000],
    ["150,000", 15_000_000],
    ["150,000.5", 15_000_050],
    ["150,000.50", 15_000_050],
    ["₦ 1,500.05", 150_005],
    ["NGN 20", 2_000],
    ["0", 0],
    ["0.01", 1],
    ["  99.99 ", 9_999],
  ])("reads %j as %i kobo", (text, kobo) => {
    expect(nairaToKobo(text)).toBe(kobo);
  });

  it("is exact where floating point is not: 0.1 + 0.2 style amounts never drift", () => {
    expect(nairaToKobo("1234567.89")).toBe(123_456_789);
    expect(nairaToKobo("19.99") + nairaToKobo("0.01")).toBe(2_000);
  });

  it.each(["", "abc", "1.234", "-5", "1e5", "1,00.5.5", ".5", "5.", "12 000", "99999999999999999"])(
    "refuses %j",
    (text) => {
      expect(() => nairaToKobo(text)).toThrow(MoneyError);
    }
  );

  it("refuses an amount over the ceiling", () => {
    expect(() => nairaToKobo("10000000001")).toThrow(/too large/);
    expect(nairaToKobo("10000000000")).toBe(MAX_KOBO);
  });
});

describe("formatNaira", () => {
  it.each([
    [0, "₦0.00"],
    [5, "₦0.05"],
    [100, "₦1.00"],
    [15_000_000, "₦150,000.00"],
    [123_456_789, "₦1,234,567.89"],
    [-250, "-₦2.50"],
  ])("%i kobo is %s", (kobo, text) => {
    expect(formatNaira(kobo)).toBe(text);
  });
  it("round-trips with nairaToKobo", () => {
    for (const kobo of [0, 1, 99, 100, 101, 15_000_050, 987_654_321]) {
      expect(nairaToKobo(formatNaira(kobo))).toBe(kobo);
    }
  });
});
