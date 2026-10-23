import { AuthApiError, AuthRetryableFetchError } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  signInWithPassword: vi.fn(),
  signOut: vi.fn(),
  getAal: vi.fn(),
  getUser: vi.fn(),
  challengeAndVerify: vi.fn(),
  maybeSingle: vi.fn(),
  writeAudit: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: {
      signInWithPassword: mocks.signInWithPassword,
      signOut: mocks.signOut,
      getUser: mocks.getUser,
      mfa: {
        getAuthenticatorAssuranceLevel: mocks.getAal,
        challengeAndVerify: mocks.challengeAndVerify,
      },
    },
  })),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: mocks.maybeSingle }) }) }),
  })),
}));
vi.mock("@/lib/audit", () => ({ writeAudit: mocks.writeAudit }));

import { signInWithPassword, verifyChallenge } from "@/lib/actions/auth";

const user = { id: "u1", email: "me@example.com" };

beforeEach(() => {
  Object.values(mocks).forEach((m) => m.mockReset());
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  mocks.signInWithPassword.mockResolvedValue({ data: { user }, error: null });
  mocks.maybeSingle.mockResolvedValue({ data: { is_active: true }, error: null });
  mocks.getAal.mockResolvedValue({ data: { currentLevel: "aal1" } });
  mocks.getUser.mockResolvedValue({ data: { user } });
  mocks.challengeAndVerify.mockResolvedValue({ error: null });
  mocks.writeAudit.mockResolvedValue(undefined);
  mocks.signOut.mockResolvedValue({ error: null });
});

describe("signInWithPassword", () => {
  it("says unavailable, not invalid, when Supabase cannot be reached (the 'fetch failed' case)", async () => {
    mocks.signInWithPassword.mockResolvedValue({
      data: { user: null },
      error: new AuthRetryableFetchError("fetch failed", 0),
    });
    await expect(signInWithPassword("me@example.com", "pw")).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });
    // Not a failed attempt by this person, so nothing is logged against them.
    expect(mocks.writeAudit).not.toHaveBeenCalled();
  });

  it("says unavailable for a server error", async () => {
    mocks.signInWithPassword.mockResolvedValue({
      data: { user: null },
      error: new AuthApiError("upstream down", 503, "unexpected_failure"),
    });
    await expect(signInWithPassword("me@example.com", "pw")).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });
  });

  it("says invalid for a wrong password and records the failed attempt", async () => {
    mocks.signInWithPassword.mockResolvedValue({
      data: { user: null },
      error: new AuthApiError("Invalid login credentials", 400, "invalid_credentials"),
    });
    await expect(signInWithPassword("me@example.com", "wrong")).resolves.toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(mocks.writeAudit).toHaveBeenCalledWith(
      { email: "me@example.com" },
      expect.objectContaining({ action: "auth.login_failed" })
    );
  });

  it("still returns invalid, instead of crashing, when the audit write also fails", async () => {
    mocks.signInWithPassword.mockResolvedValue({
      data: { user: null },
      error: new AuthApiError("Invalid login credentials", 400, "invalid_credentials"),
    });
    mocks.writeAudit.mockRejectedValue(new Error("Could not write the audit log: fetch failed"));
    await expect(signInWithPassword("me@example.com", "wrong")).resolves.toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("signs out and says unavailable if the role list cannot be read", async () => {
    mocks.maybeSingle.mockResolvedValue({ data: null, error: { message: "fetch failed" } });
    await expect(signInWithPassword("me@example.com", "pw")).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });
    expect(mocks.signOut).toHaveBeenCalled();
  });

  it.each([
    ["not on the list", { data: null, error: null }],
    ["deactivated", { data: { is_active: false }, error: null }],
  ])("signs out and says no-access when the account is %s", async (_name, result) => {
    mocks.maybeSingle.mockResolvedValue(result);
    await expect(signInWithPassword("me@example.com", "pw")).resolves.toEqual({
      ok: false,
      reason: "no-access",
    });
    expect(mocks.signOut).toHaveBeenCalled();
  });

  it("sends a password-only sign-in to the 2FA step, and a 2FA session home", async () => {
    await expect(signInWithPassword("me@example.com", "pw")).resolves.toEqual({
      ok: true,
      next: "/mfa",
    });
    mocks.getAal.mockResolvedValue({ data: { currentLevel: "aal2" } });
    await expect(signInWithPassword("me@example.com", "pw")).resolves.toEqual({
      ok: true,
      next: "/",
    });
  });
});

describe("verifyChallenge", () => {
  it("returns true and records the login", async () => {
    await expect(verifyChallenge("f1", "123456")).resolves.toBe(true);
    expect(mocks.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ id: "u1" }),
      expect.objectContaining({ action: "auth.login" })
    );
  });

  it("returns false for a wrong code and records the failure", async () => {
    mocks.challengeAndVerify.mockResolvedValue({ error: { message: "invalid code" } });
    await expect(verifyChallenge("f1", "000000")).resolves.toBe(false);
    expect(mocks.writeAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "auth.mfa_failed" })
    );
  });

  it("does not crash a correct sign-in if the audit write fails", async () => {
    mocks.writeAudit.mockRejectedValue(new Error("db down"));
    await expect(verifyChallenge("f1", "123456")).resolves.toBe(true);
  });
});
