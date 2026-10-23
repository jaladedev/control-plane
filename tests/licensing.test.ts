import { describe, expect, it } from "vitest";
import { buildLicense, defaultValidUntil, isUnsynced, licenseInputSchema } from "@/lib/licensing";

const now = new Date("2026-10-23T10:00:00Z");
const base = {
  kind: "paid",
  session: "2026/2027",
  valid_until: "2027-07-31",
  grace_days: "14",
  student_cap: "400",
  features: "Messaging, transport",
};

describe("licenseInputSchema", () => {
  it("parses the form values", () => {
    const parsed = licenseInputSchema.parse(base);
    expect(parsed).toMatchObject({
      kind: "paid",
      grace_days: 14,
      student_cap: 400,
      features: ["messaging", "transport"],
    });
  });

  it("treats a blank cap as no cap and blank add-ons as none", () => {
    const parsed = licenseInputSchema.parse({ ...base, student_cap: " ", features: "" });
    expect(parsed.student_cap).toBeNull();
    expect(parsed.features).toEqual([]);
  });

  it("removes duplicate add-ons", () => {
    expect(licenseInputSchema.parse({ ...base, features: "a_b, A_B  a_b" }).features).toEqual([
      "a_b",
    ]);
  });

  it.each([
    ["a bad cap", { student_cap: "-5" }],
    ["a fractional cap", { student_cap: "2.5" }],
    ["an unknown type", { kind: "free" }],
    ["a blank session", { session: "  " }],
    ["a malformed date", { valid_until: "31/07/2027" }],
    ["too many grace days", { grace_days: "91" }],
    ["negative grace", { grace_days: "-1" }],
    ["an invalid add-on", { features: "messaging, bad-name" }],
  ])("refuses %s", (_name, patch) => {
    expect(licenseInputSchema.safeParse({ ...base, ...patch }).success).toBe(false);
  });
});

describe("buildLicense", () => {
  const parse = (patch = {}) => licenseInputSchema.parse({ ...base, ...patch });

  it("is valid to the end of the chosen day and grace runs on from there", () => {
    const l = buildLicense(parse(), now);
    expect(l.valid_until).toBe("2027-07-31T23:59:59.000Z");
    expect(l.grace_until).toBe("2027-08-14T23:59:59.000Z");
    expect(l).toMatchObject({ is_trial: false, session: "2026/2027", student_cap: 400 });
  });

  it("flags a trial", () => {
    expect(buildLicense(parse({ kind: "trial" }), now).is_trial).toBe(true);
  });

  it("allows zero grace days (grace ends when validity does)", () => {
    const l = buildLicense(parse({ grace_days: "0" }), now);
    expect(l.grace_until).toBe(l.valid_until);
  });

  it("refuses a date in the past and points to Revoke", () => {
    expect(() => buildLicense(parse({ valid_until: "2026-10-01" }), now)).toThrow(/Revoke/);
  });

  it("accepts today (valid to the end of today)", () => {
    expect(() => buildLicense(parse({ valid_until: "2026-10-23" }), now)).not.toThrow();
  });

  it("refuses a date more than three years away", () => {
    expect(() => buildLicense(parse({ valid_until: "2031-01-01" }), now)).toThrow(/three years/);
  });

  it("refuses an impossible calendar date", () => {
    expect(() => buildLicense(parse({ valid_until: "2027-13-45" }), now)).toThrow();
  });
});

describe("helpers", () => {
  it("prefills the default trial length", () => {
    expect(defaultValidUntil(now)).toBe("2026-11-22");
  });
  it("knows when a saved version has not been delivered", () => {
    expect(isUnsynced({ license_version: 3, license_pushed_version: 2 })).toBe(true);
    expect(isUnsynced({ license_version: 3, license_pushed_version: 3 })).toBe(false);
    expect(isUnsynced({ license_version: 0, license_pushed_version: 0 })).toBe(false);
  });
});
