import { describe, expect, it } from "vitest";
import { decideAccess, isPublicPath } from "@/lib/access";

const go = (to: string) => ({ action: "redirect", to });
const allow = { action: "allow" };

describe("decideAccess", () => {
  it("lets the health probe and the scheduler's route through for anyone", () => {
    for (const path of ["/api/health", "/api/cron/health"]) {
      expect(decideAccess({ path, signedIn: false, aal: null })).toEqual(allow);
      expect(decideAccess({ path, signedIn: true, aal: "aal1" })).toEqual(allow);
    }
  });

  it("lets the signed school and Paystack endpoints through, and only those", () => {
    for (const path of [
      "/api/claims",
      "/api/claims/proof",
      "/api/invoices",
      "/api/paystack/checkout",
      "/api/paystack/webhook",
    ]) {
      expect(isPublicPath(path)).toBe(true);
      expect(decideAccess({ path, signedIn: false, aal: null })).toEqual(allow);
    }
    for (const path of [
      "/api/claims/other",
      "/api/invoices/x",
      "/api/claims/proof/",
      "/api/paystack",
      "/api/paystack/other",
      "/billing/x/pdf",
      "/billing/proof/x",
    ]) {
      expect(isPublicPath(path)).toBe(false);
      expect(decideAccess({ path, signedIn: false, aal: null })).toEqual(go("/login"));
    }
  });

  it("does not open anything else under /api/cron", () => {
    expect(decideAccess({ path: "/api/cron/other", signedIn: false, aal: null })).toEqual(
      go("/login")
    );
  });

  describe("signed out", () => {
    it("can only see the login page", () => {
      expect(decideAccess({ path: "/login", signedIn: false, aal: null })).toEqual(allow);
      for (const path of ["/", "/users", "/audit", "/mfa", "/anything-else"]) {
        expect(decideAccess({ path, signedIn: false, aal: null })).toEqual(go("/login"));
      }
    });
  });

  describe("signed in with a password only (aal1)", () => {
    it("is held at the 2FA step", () => {
      expect(decideAccess({ path: "/mfa", signedIn: true, aal: "aal1" })).toEqual(allow);
      for (const path of ["/", "/users", "/audit", "/login", "/anything-else"]) {
        expect(decideAccess({ path, signedIn: true, aal: "aal1" })).toEqual(go("/mfa"));
      }
    });

    it("is treated the same when the level is unknown", () => {
      expect(decideAccess({ path: "/users", signedIn: true, aal: null })).toEqual(go("/mfa"));
    });
  });

  describe("signed in with 2FA (aal2)", () => {
    it("can reach the app", () => {
      for (const path of ["/", "/users", "/audit"]) {
        expect(decideAccess({ path, signedIn: true, aal: "aal2" })).toEqual(allow);
      }
    });

    it("is sent home from the login and 2FA pages", () => {
      expect(decideAccess({ path: "/login", signedIn: true, aal: "aal2" })).toEqual(go("/"));
      expect(decideAccess({ path: "/mfa", signedIn: true, aal: "aal2" })).toEqual(go("/"));
    });
  });
});
