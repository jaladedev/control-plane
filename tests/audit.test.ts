import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  insert: vi.fn(),
  headers: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => ({ from: () => ({ insert: mocks.insert }) })),
}));
vi.mock("next/headers", () => ({ headers: mocks.headers }));

import { withAudit, writeAudit } from "@/lib/audit";

const actor = { id: "u1", email: "owner@example.com", role: "owner" as const };

beforeEach(() => {
  mocks.insert.mockReset();
  mocks.insert.mockResolvedValue({ error: null });
  mocks.headers.mockReset();
  mocks.headers.mockResolvedValue(new Headers({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" }));
});

const rows = () => mocks.insert.mock.calls.map((c) => c[0]);

describe("writeAudit", () => {
  it("writes who, what, which school and where from", async () => {
    await writeAudit(actor, {
      action: "school.pause",
      schoolId: "s1",
      details: { reason: "unpaid" },
    });
    expect(rows()).toEqual([
      {
        actor_id: "u1",
        actor_email: "owner@example.com",
        role: "owner",
        action: "school.pause",
        school_id: "s1",
        details: { reason: "unpaid" },
        ip: "203.0.113.9",
      },
    ]);
  });

  it("prefers Cloudflare's client address when present", async () => {
    mocks.headers.mockResolvedValue(
      new Headers({ "cf-connecting-ip": "198.51.100.7", "x-forwarded-for": "203.0.113.9" })
    );
    await writeAudit(actor, { action: "x" });
    expect(rows()[0].ip).toBe("198.51.100.7");
  });

  it("records a partial actor, such as a failed sign-in with only an email", async () => {
    await writeAudit({ email: "who@example.com" }, { action: "auth.login_failed" });
    expect(rows()[0]).toMatchObject({ actor_id: null, actor_email: "who@example.com", role: null });
  });

  it("still writes outside a request, with no address", async () => {
    mocks.headers.mockRejectedValue(new Error("outside a request scope"));
    await writeAudit(actor, { action: "x" });
    expect(rows()[0].ip).toBeNull();
  });

  it("throws when the row cannot be written", async () => {
    mocks.insert.mockResolvedValue({ error: { message: "db down" } });
    await expect(writeAudit(actor, { action: "x" })).rejects.toThrow(
      "Could not write the audit log: db down"
    );
  });
});

describe("withAudit", () => {
  it("writes the audit row before running the action, and returns its result", async () => {
    const order: string[] = [];
    mocks.insert.mockImplementation(async () => {
      order.push("audit");
      return { error: null };
    });
    const result = await withAudit(actor, { action: "user.create" }, async () => {
      order.push("action");
      return 42;
    });
    expect(result).toBe(42);
    expect(order).toEqual(["audit", "action"]);
  });

  it("does not run the action if the audit row cannot be written", async () => {
    mocks.insert.mockResolvedValue({ error: { message: "db down" } });
    const fn = vi.fn();
    await expect(withAudit(actor, { action: "user.create" }, fn)).rejects.toThrow(/audit log/);
    expect(fn).not.toHaveBeenCalled();
  });

  it("records a .failed row with the error when the action throws, and rethrows it", async () => {
    await expect(
      withAudit(actor, { action: "user.create", details: { email: "a@b.c" } }, async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    expect(rows().map((r) => r.action)).toEqual(["user.create", "user.create.failed"]);
    expect(rows()[1].details).toEqual({ email: "a@b.c", error: "boom" });
  });

  it("rethrows the original error even if recording the failure also fails", async () => {
    mocks.insert
      .mockResolvedValueOnce({ error: null })
      .mockResolvedValueOnce({ error: { message: "db down" } });
    await expect(
      withAudit(actor, { action: "x" }, async () => {
        throw new Error("the real problem");
      })
    ).rejects.toThrow("the real problem");
  });
});
