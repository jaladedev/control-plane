import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireActor: vi.fn(),
  withAudit: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
  single: vi.fn(),
  overlaps: vi.fn(),
}));

vi.mock("@/lib/auth/guards", () => ({ requireActor: mocks.requireActor }));
vi.mock("@/lib/audit", () => ({ withAudit: mocks.withAudit }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => ({
    from: () => ({
      insert: mocks.insert,
      update: (values: unknown) => ({ eq: (...a: unknown[]) => mocks.update(values, ...a) }),
      select: () => ({
        eq: () => ({ single: mocks.single }),
        // assertHostnamesFree awaits this directly, or after .neq(...)
        overlaps: () =>
          Object.assign(Promise.resolve(mocks.overlaps()), {
            neq: () => Promise.resolve(mocks.overlaps()),
          }),
      }),
    }),
  })),
}));

import { createSchool, setSchoolStatus, updateSchool } from "@/lib/actions/schools";

const owner = { id: "11111111-1111-4111-8111-111111111111", email: "o@example.com", role: "owner" };
const schoolId = "22222222-2222-4222-8222-222222222222";
const form = {
  slug: "greenfield",
  name: "Greenfield School",
  hostnames: "green.example.com",
  included_students: "300",
  hosting_plan: "pro",
};

let audited: Array<{ action: string; schoolId?: string | null; details?: Record<string, unknown> }>;
let order: string[];

beforeEach(() => {
  Object.values(mocks).forEach((m) => m.mockReset());
  audited = [];
  order = [];
  mocks.requireActor.mockResolvedValue(owner);
  // The real withAudit writes the row, then runs the action; model that order.
  mocks.withAudit.mockImplementation(async (_actor, entry, fn) => {
    audited.push(entry);
    order.push("audit");
    return fn();
  });
  mocks.insert.mockImplementation(async () => {
    order.push("insert");
    return { error: null };
  });
  mocks.update.mockImplementation(async () => {
    order.push("update");
    return { error: null };
  });
  mocks.overlaps.mockReturnValue({ data: [], error: null });
  mocks.single.mockResolvedValue({
    // A full row, as the database returns it: every nullable column is null.
    data: {
      slug: "greenfield",
      status: "provisioning",
      name: "Greenfield School",
      hostnames: ["green.example.com"],
      included_students: 300,
      hosting_plan: "pro",
      rollout_group: "standard",
      billing_contact_name: null,
      billing_contact_email: null,
      region: null,
      supabase_project_ref: null,
      supabase_account_email: null,
      cloudflare_account_email: null,
      r2_bucket: null,
      container_name: null,
    },
    error: null,
  });
});

describe("every school action is owner-only", () => {
  const denied = Object.assign(new Error("Your role cannot do this."), { code: "forbidden" });

  it.each([
    ["createSchool", () => createSchool(form)],
    ["updateSchool", () => updateSchool(schoolId, form)],
    ["setSchoolStatus", () => setSchoolStatus(schoolId, "active")],
  ])("%s asks for the owner role and does nothing when refused", async (_name, call) => {
    mocks.requireActor.mockRejectedValue(denied);
    await expect(call()).rejects.toBe(denied);
    expect(mocks.requireActor).toHaveBeenCalledWith(["owner"]);
    expect(mocks.withAudit).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });
});

describe("createSchool", () => {
  it("audits first (with the new id), then inserts the same id", async () => {
    const { id } = await createSchool(form);
    expect(order).toEqual(["audit", "insert"]);
    expect(audited[0]).toMatchObject({
      action: "school.create",
      schoolId: id,
      details: { slug: "greenfield", hostnames: ["green.example.com"] },
    });
    expect(mocks.insert.mock.calls[0][0]).toMatchObject({
      id,
      slug: "greenfield",
      hostnames: ["green.example.com"],
      included_students: 300,
    });
  });

  it("refuses an invalid hostname before anything is written", async () => {
    await expect(createSchool({ ...form, hostnames: "localhost" })).rejects.toThrow();
    expect(mocks.withAudit).not.toHaveBeenCalled();
  });

  it("refuses a hostname another school already uses", async () => {
    mocks.overlaps.mockReturnValue({ data: [{ slug: "bluefield" }], error: null });
    await expect(createSchool(form)).rejects.toThrow(/already used by the school "bluefield"/);
    expect(mocks.withAudit).not.toHaveBeenCalled();
  });

  it("explains a duplicate slug", async () => {
    mocks.insert.mockResolvedValue({ error: { code: "23505", message: "duplicate key" } });
    await expect(createSchool(form)).rejects.toThrow(/slug "greenfield" is already in use/);
  });
});

describe("updateSchool", () => {
  it("audits only what changed, then updates", async () => {
    await updateSchool(schoolId, { ...form, name: "Greenfield Academy", region: "Lagos" });
    expect(order).toEqual(["audit", "update"]);
    expect(audited[0].action).toBe("school.update");
    expect(audited[0].details).toMatchObject({
      slug: "greenfield",
      changes: {
        name: { from: "Greenfield School", to: "Greenfield Academy" },
        region: { from: null, to: "Lagos" },
      },
    });
    expect(Object.keys((audited[0].details as { changes: object }).changes).sort()).toEqual([
      "name",
      "region",
    ]);
  });

  it("does nothing, and writes no audit row, when nothing changed", async () => {
    await updateSchool(schoolId, form);
    expect(mocks.withAudit).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("does not change the slug even if one is submitted", async () => {
    await updateSchool(schoolId, { ...form, slug: "hijack", name: "New name" });
    expect(mocks.update.mock.calls[0][0]).not.toHaveProperty("slug");
  });

  it("refuses an unknown school", async () => {
    mocks.single.mockResolvedValue({ data: null, error: { message: "no rows" } });
    await expect(updateSchool(schoolId, form)).rejects.toThrow(/does not exist/);
  });
});

describe("setSchoolStatus", () => {
  it("audits the old and new status, then updates", async () => {
    await setSchoolStatus(schoolId, "active");
    expect(order).toEqual(["audit", "update"]);
    expect(audited[0]).toMatchObject({
      action: "school.status_change",
      schoolId,
      details: { slug: "greenfield", from: "provisioning", to: "active" },
    });
    expect(mocks.update.mock.calls[0][0]).toEqual({ status: "active" });
  });

  it("does nothing when the status is already that", async () => {
    await setSchoolStatus(schoolId, "provisioning");
    expect(mocks.withAudit).not.toHaveBeenCalled();
  });

  it("refuses an unknown status", async () => {
    await expect(setSchoolStatus(schoolId, "deleted")).rejects.toThrow();
    expect(mocks.update).not.toHaveBeenCalled();
  });
});

describe("rollout group", () => {
  it("defaults to standard and records a change in the audit row", async () => {
    await updateSchool(schoolId, { ...form, rollout_group: "test" });
    expect(audited[0].details).toMatchObject({
      changes: { rollout_group: { from: "standard", to: "test" } },
    });
    expect(mocks.update.mock.calls[0][0]).toMatchObject({ rollout_group: "test" });
  });

  it("refuses an unknown group before anything is written", async () => {
    await expect(updateSchool(schoolId, { ...form, rollout_group: "canary" })).rejects.toThrow();
    expect(mocks.withAudit).not.toHaveBeenCalled();
  });

  it("sets it when a school is created", async () => {
    await createSchool({ ...form, rollout_group: "pilot" });
    expect(mocks.insert.mock.calls[0][0]).toMatchObject({ rollout_group: "pilot" });
  });
});
