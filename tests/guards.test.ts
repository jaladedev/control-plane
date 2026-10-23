import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  getAal: vi.fn(),
  rpc: vi.fn(),
  redirect: vi.fn((to: string) => {
    throw new Error(`NEXT_REDIRECT:${to}`);
  }),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: mocks.getUser, mfa: { getAuthenticatorAssuranceLevel: mocks.getAal } },
    rpc: mocks.rpc,
  })),
}));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));

import { AccessError, requireActor, requirePage, resolveActor } from "@/lib/auth/guards";

function signedInAs(opts: { aal?: string; role?: unknown; user?: boolean } = {}) {
  const { aal = "aal2", user = true } = opts;
  // "role" in opts, so an explicit undefined is passed through, not defaulted.
  const role = "role" in opts ? opts.role : "owner";
  mocks.getUser.mockResolvedValue(
    user
      ? { data: { user: { id: "u1", email: "me@example.com" } }, error: null }
      : { data: { user: null }, error: { message: "no session" } }
  );
  mocks.getAal.mockResolvedValue({ data: { currentLevel: aal } });
  mocks.rpc.mockResolvedValue({ data: role, error: null });
}

beforeEach(() => {
  Object.values(mocks).forEach((m) => "mockClear" in m && m.mockClear());
});

describe("resolveActor", () => {
  it("returns the actor for a verified, 2FA session of an active dashboard user", async () => {
    signedInAs({ role: "finance" });
    await expect(resolveActor()).resolves.toEqual({
      actor: { id: "u1", email: "me@example.com", role: "finance" },
    });
    expect(mocks.rpc).toHaveBeenCalledWith("dashboard_role");
  });

  it("says signed_out when there is no verified session", async () => {
    signedInAs({ user: false });
    await expect(resolveActor()).resolves.toEqual({ error: "signed_out" });
  });

  it("says needs_2fa for a password-only session, without asking the database for a role", async () => {
    signedInAs({ aal: "aal1" });
    await expect(resolveActor()).resolves.toEqual({ error: "needs_2fa" });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it.each([[null], ["superadmin"], [undefined], [42]])(
    "says no_access when the database returns %j instead of a known role",
    async (role) => {
      signedInAs({ role });
      await expect(resolveActor()).resolves.toEqual({ error: "no_access" });
    }
  );

  it("says no_access when the role lookup fails", async () => {
    signedInAs();
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "boom" } });
    await expect(resolveActor()).resolves.toEqual({ error: "no_access" });
  });
});

describe("requireActor", () => {
  it("returns the actor when no role limit is given", async () => {
    signedInAs({ role: "support" });
    await expect(requireActor()).resolves.toMatchObject({ role: "support" });
  });

  it("allows a role in the list and refuses one outside it", async () => {
    signedInAs({ role: "finance" });
    await expect(requireActor(["owner", "finance"])).resolves.toMatchObject({ role: "finance" });
    await expect(requireActor(["owner"])).rejects.toMatchObject({ code: "forbidden" });
  });

  it.each([
    [{ user: false }, "signed_out"],
    [{ aal: "aal1" }, "needs_2fa"],
    [{ role: null }, "no_access"],
  ])("refuses with the right code: %j", async (state, code) => {
    signedInAs(state);
    const error = await requireActor(["owner"]).catch((e) => e);
    expect(error).toBeInstanceOf(AccessError);
    expect(error.code).toBe(code);
  });
});

describe("requirePage", () => {
  it("returns the actor when allowed", async () => {
    signedInAs();
    await expect(requirePage(["owner"])).resolves.toMatchObject({ role: "owner" });
  });

  it("sends a password-only session to the 2FA step", async () => {
    signedInAs({ aal: "aal1" });
    await expect(requirePage()).rejects.toThrow("NEXT_REDIRECT:/mfa");
  });

  it("sends a signed-out visitor and a non-dashboard account to /login", async () => {
    signedInAs({ user: false });
    await expect(requirePage()).rejects.toThrow("NEXT_REDIRECT:/login");
    signedInAs({ role: null });
    await expect(requirePage()).rejects.toThrow("NEXT_REDIRECT:/login");
  });

  it("sends a role that is not allowed home", async () => {
    signedInAs({ role: "support" });
    await expect(requirePage(["owner"])).rejects.toThrow("NEXT_REDIRECT:/");
  });
});
