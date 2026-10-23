import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireActor: vi.fn(),
  withAudit: vi.fn(),
  createUser: vi.fn(),
  deleteUser: vi.fn(),
  updateUserById: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
  single: vi.fn(),
}));

vi.mock("@/lib/auth/guards", () => ({ requireActor: mocks.requireActor }));
vi.mock("@/lib/audit", () => ({ withAudit: mocks.withAudit }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => ({
    auth: {
      admin: {
        createUser: mocks.createUser,
        deleteUser: mocks.deleteUser,
        updateUserById: mocks.updateUserById,
      },
    },
    from: () => ({
      insert: mocks.insert,
      update: (values: unknown) => ({ eq: (...a: unknown[]) => mocks.update(values, ...a) }),
      select: () => ({ eq: () => ({ single: mocks.single }) }),
    }),
  })),
}));

import {
  createDashboardUser,
  setDashboardUserActive,
  setDashboardUserRole,
} from "@/lib/actions/users";

const owner = { id: "11111111-1111-4111-8111-111111111111", email: "o@example.com", role: "owner" };
const target = "22222222-2222-4222-8222-222222222222";

let audited: Array<{ action: string; details?: Record<string, unknown> }>;

beforeEach(() => {
  Object.values(mocks).forEach((m) => m.mockReset());
  audited = [];
  mocks.requireActor.mockResolvedValue(owner);
  // The real withAudit writes the row, then runs the action; model that order.
  mocks.withAudit.mockImplementation(async (_actor, entry, fn) => {
    audited.push(entry);
    return fn();
  });
  mocks.createUser.mockResolvedValue({ data: { user: { id: target } }, error: null });
  mocks.insert.mockResolvedValue({ error: null });
  mocks.update.mockResolvedValue({ error: null });
  mocks.updateUserById.mockResolvedValue({ error: null });
  mocks.deleteUser.mockResolvedValue({ error: null });
  mocks.single.mockResolvedValue({
    data: { email: "t@example.com", role: "support" },
    error: null,
  });
});

describe("every user action is owner-only", () => {
  const denied = Object.assign(new Error("Your role cannot do this."), { code: "forbidden" });

  it.each([
    [
      "createDashboardUser",
      () =>
        createDashboardUser({
          email: "a@b.co",
          role: "support",
          temporaryPassword: "x".repeat(12),
        }),
    ],
    ["setDashboardUserRole", () => setDashboardUserRole({ userId: target, role: "owner" })],
    ["setDashboardUserActive", () => setDashboardUserActive({ userId: target, active: false })],
  ])("%s asks for the owner role and does nothing when refused", async (_name, call) => {
    mocks.requireActor.mockRejectedValue(denied);
    await expect(call()).rejects.toBe(denied);
    expect(mocks.requireActor).toHaveBeenCalledWith(["owner"]);
    expect(mocks.withAudit).not.toHaveBeenCalled();
    expect(mocks.createUser).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });
});

describe("createDashboardUser", () => {
  const input = {
    email: "  New@Example.COM ",
    role: "finance",
    temporaryPassword: "a-long-password-1",
  };

  it("audits first, then creates the login and the role row, and normalises the email", async () => {
    const result = await createDashboardUser(input);
    expect(result).toEqual({ id: target });
    expect(audited).toEqual([
      { action: "user.create", details: { email: "new@example.com", role: "finance" } },
    ]);
    expect(mocks.createUser).toHaveBeenCalledWith({
      email: "new@example.com",
      password: "a-long-password-1",
      email_confirm: true,
    });
    expect(mocks.insert).toHaveBeenCalledWith({
      id: target,
      email: "new@example.com",
      role: "finance",
      created_by: owner.id,
    });
  });

  it.each([
    [{ ...input, email: "not-an-email" }, /email/i],
    [{ ...input, role: "superadmin" }, /./],
    [{ ...input, temporaryPassword: "short" }, /12 characters/],
  ])("rejects bad input before auditing or creating anything: %j", async (bad, message) => {
    await expect(createDashboardUser(bad)).rejects.toThrow(message);
    expect(mocks.withAudit).not.toHaveBeenCalled();
    expect(mocks.createUser).not.toHaveBeenCalled();
  });

  it("removes the login again if the role row cannot be saved", async () => {
    mocks.insert.mockResolvedValue({ error: { message: "duplicate email" } });
    await expect(createDashboardUser(input)).rejects.toThrow("duplicate email");
    expect(mocks.deleteUser).toHaveBeenCalledWith(target);
  });

  it("surfaces a failure to create the login without trying to save a role", async () => {
    mocks.createUser.mockResolvedValue({
      data: { user: null },
      error: { message: "already registered" },
    });
    await expect(createDashboardUser(input)).rejects.toThrow("already registered");
    expect(mocks.insert).not.toHaveBeenCalled();
  });
});

describe("setDashboardUserRole", () => {
  it("records the old and new role, then changes it", async () => {
    await setDashboardUserRole({ userId: target, role: "owner" });
    expect(audited).toEqual([
      {
        action: "user.role_change",
        details: { user_id: target, email: "t@example.com", from: "support", to: "owner" },
      },
    ]);
    expect(mocks.update).toHaveBeenCalledWith({ role: "owner" }, "id", target);
  });

  it("shows the database's refusal to demote the last owner", async () => {
    mocks.update.mockResolvedValue({
      error: { message: "There must always be at least one active owner" },
    });
    await expect(setDashboardUserRole({ userId: target, role: "support" })).rejects.toThrow(
      /at least one active owner/
    );
  });

  it("refuses an unknown role or id before doing anything", async () => {
    await expect(setDashboardUserRole({ userId: target, role: "root" })).rejects.toThrow();
    await expect(setDashboardUserRole({ userId: "not-a-uuid", role: "owner" })).rejects.toThrow();
    expect(mocks.withAudit).not.toHaveBeenCalled();
  });

  it("says so when the user does not exist", async () => {
    mocks.single.mockResolvedValue({ data: null, error: { message: "no rows" } });
    await expect(setDashboardUserRole({ userId: target, role: "owner" })).rejects.toThrow(
      "That user does not exist."
    );
    expect(mocks.withAudit).not.toHaveBeenCalled();
  });
});

describe("setDashboardUserActive", () => {
  it("deactivates in the table first, then blocks the login", async () => {
    const order: string[] = [];
    mocks.update.mockImplementation(async () => {
      order.push("table");
      return { error: null };
    });
    mocks.updateUserById.mockImplementation(async () => {
      order.push("login");
      return { error: null };
    });
    await setDashboardUserActive({ userId: target, active: false });
    expect(audited[0].action).toBe("user.deactivate");
    expect(order).toEqual(["table", "login"]);
    expect(mocks.update).toHaveBeenCalledWith({ is_active: false }, "id", target);
    expect(mocks.updateUserById).toHaveBeenCalledWith(target, { ban_duration: "876000h" });
  });

  it("reactivates and lifts the block", async () => {
    await setDashboardUserActive({ userId: target, active: true });
    expect(audited[0].action).toBe("user.activate");
    expect(mocks.updateUserById).toHaveBeenCalledWith(target, { ban_duration: "none" });
  });

  it("does not touch the login if the table refuses (last owner)", async () => {
    mocks.update.mockResolvedValue({
      error: { message: "There must always be at least one active owner" },
    });
    await expect(setDashboardUserActive({ userId: target, active: false })).rejects.toThrow(
      /active owner/
    );
    expect(mocks.updateUserById).not.toHaveBeenCalled();
  });
});
