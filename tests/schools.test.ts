import { describe, expect, it } from "vitest";
import {
  licenseState,
  normalizeHostname,
  parseHostnames,
  schoolDetailsSchema,
  slugSchema,
} from "@/lib/schools";

describe("normalizeHostname", () => {
  it("lowercases and trims a public name", () => {
    expect(normalizeHostname("  School.Example.COM ")).toBe("school.example.com");
  });

  it.each([
    "localhost",
    "school",
    "127.0.0.1",
    "10.0.0.5",
    "[::1]",
    "a.com:8080",
    "a.com/path",
    "https://a.com",
    "a b.com",
    "-bad.example.com",
    "",
  ])("refuses %j", (value) => {
    expect(() => normalizeHostname(value)).toThrow();
  });

  it.each(["db.internal", "printer.local", "app.localhost", "x.example.test"])(
    "refuses the private name %s",
    (value) => {
      expect(() => normalizeHostname(value)).toThrow(/private|valid/);
    }
  );
});

describe("parseHostnames", () => {
  it("splits on commas, spaces and newlines and removes duplicates", () => {
    expect(parseHostnames("a.example.com, B.example.com\na.example.com")).toEqual([
      "a.example.com",
      "b.example.com",
    ]);
  });
  it("accepts an empty list", () => {
    expect(parseHostnames("")).toEqual([]);
  });
  it("allows at most five", () => {
    const six = Array.from({ length: 6 }, (_, i) => `s${i}.example.com`).join(",");
    expect(() => parseHostnames(six)).toThrow(/at most 5/);
  });
});

describe("slugSchema", () => {
  it("accepts and lowercases a good slug", () => {
    expect(slugSchema.parse(" Green-Field ")).toBe("green-field");
  });
  it.each(["ab", "-abc", "abc-", "has space", "under_score", "x".repeat(41)])(
    "refuses %j",
    (value) => {
      expect(slugSchema.safeParse(value).success).toBe(false);
    }
  );
});

describe("schoolDetailsSchema", () => {
  const base = {
    name: "Greenfield",
    hostnames: "green.example.com",
    included_students: "250",
    hosting_plan: "pro",
  };

  it("turns blanks into null and numbers into numbers", () => {
    const parsed = schoolDetailsSchema.parse({ ...base, region: "  ", billing_contact_email: "" });
    expect(parsed.region).toBeNull();
    expect(parsed.billing_contact_email).toBeNull();
    expect(parsed.included_students).toBe(250);
    expect(parsed.hostnames).toEqual(["green.example.com"]);
  });

  it("reports a bad hostname as a normal validation error", () => {
    const result = schoolDetailsSchema.safeParse({ ...base, hostnames: "localhost" });
    expect(result.success).toBe(false);
  });

  it("rejects a bad email, a negative cap and an unknown plan", () => {
    expect(schoolDetailsSchema.safeParse({ ...base, billing_contact_email: "nope" }).success).toBe(
      false
    );
    expect(schoolDetailsSchema.safeParse({ ...base, included_students: "-1" }).success).toBe(false);
    expect(schoolDetailsSchema.safeParse({ ...base, hosting_plan: "gold" }).success).toBe(false);
  });
});

describe("licenseState", () => {
  const now = new Date("2026-10-23T12:00:00Z");
  it("is none without dates", () => {
    expect(licenseState({ license_valid_until: null, license_grace_until: null }, now)).toBe(
      "none"
    );
  });
  it("is active up to valid_until, grace up to grace_until, then expired", () => {
    const at = (valid: string, grace: string) =>
      licenseState({ license_valid_until: valid, license_grace_until: grace }, now);
    expect(at("2026-10-24T00:00:00Z", "2026-11-01T00:00:00Z")).toBe("active");
    expect(at("2026-10-23T12:00:00Z", "2026-11-01T00:00:00Z")).toBe("active");
    expect(at("2026-10-20T00:00:00Z", "2026-10-30T00:00:00Z")).toBe("grace");
    expect(at("2026-10-01T00:00:00Z", "2026-10-10T00:00:00Z")).toBe("expired");
  });
});
