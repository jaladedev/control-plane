import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireActor: vi.fn(),
  withAudit: vi.fn(),
  update: vi.fn(),
  single: vi.fn(),
  rpc: vi.fn(),
  createSchoolClient: vi.fn(),
}));

vi.mock("@/lib/auth/guards", () => ({ requireActor: mocks.requireActor }));
vi.mock("@/lib/audit", () => ({ withAudit: mocks.withAudit }));
vi.mock("@/lib/school-client", () => ({ createSchoolClient: mocks.createSchoolClient }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => ({
    from: () => ({
      select: () => ({ eq: () => ({ single: mocks.single }) }),
      update: (values: unknown) => ({ eq: (...a: unknown[]) => mocks.update(values, ...a) }),
    }),
  })),
}));

import { pushLicense, revokeLicense, setLicense } from "@/lib/actions/license";

const finance = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "f@example.com",
  role: "finance",
};
const schoolId = "22222222-2222-4222-8222-222222222222";
const now = new Date("2026-10-23T10:00:00Z");
const form = {
  kind: "paid",
  session: "2026/2027",
  valid_until: "2027-07-31",
  grace_days: "14",
  student_cap: "400",
  features: "messaging",
};

const school = (patch = {}) => ({
  id: schoolId,
  slug: "greenfield",
  status: "active",
  supabase_project_ref: "abcdefghijklmnopqrst",
  license_version: 2,
  license_session: "2025/2026",
  license_is_trial: false,
  license_valid_until: "2026-12-31T23:59:59.000Z",
  license_grace_until: "2027-01-14T23:59:59.000Z",
  included_students: 300,
  features: ["transport"],
  ...patch,
});

let audited: Array<{ action: string; details?: Record<string, unknown> }>;
let order: string[];

beforeEach(() => {
  Object.values(mocks).forEach((m) => m.mockReset());
  audited = [];
  order = [];
  mocks.requireActor.mockResolvedValue(finance);
  mocks.withAudit.mockImplementation(async (_actor, entry, fn) => {
    audited.push(entry);
    order.push("audit");
    return fn();
  });
  mocks.update.mockImplementation(async (values: Record<string, unknown>) => {
    order.push(`update:${Object.keys(values).join(",")}`);
    return { error: null };
  });
  mocks.single.mockResolvedValue({ data: school(), error: null });
  mocks.rpc.mockImplementation(async () => {
    order.push("push");
    return { data: true, error: null };
  });
  mocks.createSchoolClient.mockReturnValue({ rpc: mocks.rpc });
});

describe("who may do what", () => {
  const denied = Object.assign(new Error("Your role cannot do this."), { code: "forbidden" });

  it.each([
    ["setLicense", () => setLicense(schoolId, form, now), ["owner", "finance"]],
    ["pushLicense", () => pushLicense(schoolId), ["owner", "finance"]],
    ["revokeLicense", () => revokeLicense(schoolId, "yes", now), ["owner"]],
  ])("%s asks for %j and does nothing when refused", async (_n, call, roles) => {
    mocks.requireActor.mockRejectedValue(denied);
    await expect(call()).rejects.toBe(denied);
    expect(mocks.requireActor).toHaveBeenCalledWith(roles);
    expect(mocks.withAudit).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});

describe("setLicense", () => {
  it("audits, saves version+1, pushes it, then marks it delivered", async () => {
    const { version } = await setLicense(schoolId, form, now);
    expect(version).toBe(3);
    expect(order[0]).toBe("audit");
    expect(order[1]).toMatch(/^update:license_version/);
    expect(order[2]).toBe("push");
    expect(order[3]).toMatch(/^update:license_pushed_version/);

    expect(audited[0]).toMatchObject({
      action: "license.set",
      details: { slug: "greenfield", from_version: 2, student_cap: 400, is_trial: false },
    });
    expect(mocks.update.mock.calls[0][0]).toMatchObject({
      license_version: 3,
      included_students: 400,
      features: ["messaging"],
    });
    expect(mocks.rpc).toHaveBeenCalledWith("set_license", {
      p_school_id: schoolId,
      p_version: 3,
      p_session: "2026/2027",
      p_valid_until: "2027-07-31T23:59:59.000Z",
      p_grace_until: "2027-08-14T23:59:59.000Z",
      p_student_cap: 400,
      p_features: ["messaging"],
      p_is_trial: false,
    });
    expect(mocks.update.mock.calls[1][0]).toMatchObject({
      license_pushed_version: 3,
      license_push_error: null,
    });
  });

  it("stores no cap as 0 and pushes null", async () => {
    await setLicense(schoolId, { ...form, student_cap: "" }, now);
    expect(mocks.update.mock.calls[0][0]).toMatchObject({ included_students: 0 });
    expect(mocks.rpc.mock.calls[0][1]).toMatchObject({ p_student_cap: null });
  });

  it("starts at version 1 for a school with no licence", async () => {
    mocks.single.mockResolvedValue({
      data: school({
        license_version: 0,
        license_session: null,
        license_valid_until: null,
        license_grace_until: null,
      }),
      error: null,
    });
    expect((await setLicense(schoolId, form, now)).version).toBe(1);
  });

  it("fails before saving anything when the school cannot be reached (no key or ref)", async () => {
    mocks.createSchoolClient.mockImplementation(() => {
      throw new Error('No service key for "greenfield" in SCHOOL_SERVICE_KEYS.');
    });
    await expect(setLicense(schoolId, form, now)).rejects.toThrow(/No service key/);
    expect(mocks.withAudit).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("refuses an archived school and a bad form before saving", async () => {
    mocks.single.mockResolvedValue({ data: school({ status: "archived" }), error: null });
    await expect(setLicense(schoolId, form, now)).rejects.toThrow(/archived/);
    mocks.single.mockResolvedValue({ data: school(), error: null });
    await expect(setLicense(schoolId, { ...form, session: "" }, now)).rejects.toThrow();
    await expect(setLicense(schoolId, { ...form, valid_until: "2026-01-01" }, now)).rejects.toThrow(
      /past/
    );
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("keeps the saved version and records the error when the school rejects the push", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "school_id mismatch" } });
    await expect(setLicense(schoolId, form, now)).rejects.toThrow(
      /Saved as version 3, but not delivered.*school_id mismatch.*Retry push/s
    );
    const writes = mocks.update.mock.calls.map((c) => c[0]);
    expect(writes[0]).toMatchObject({ license_version: 3 });
    expect(writes[1]).toMatchObject({ license_push_error: expect.stringContaining("mismatch") });
    expect(writes.some((w) => "license_pushed_version" in w)).toBe(false);
  });

  it("treats 'applied: false' for a new version as a conflict, not a success", async () => {
    mocks.rpc.mockResolvedValue({ data: false, error: null });
    await expect(setLicense(schoolId, form, now)).rejects.toThrow(
      /already has licence version 3 or newer/
    );
    expect(mocks.update.mock.calls.some((c) => "license_pushed_version" in c[0])).toBe(false);
  });
});

describe("pushLicense", () => {
  it("re-sends the saved version unchanged and marks it delivered", async () => {
    await pushLicense(schoolId);
    expect(audited[0]).toMatchObject({ action: "license.push", details: { version: 2 } });
    expect(mocks.rpc.mock.calls[0][1]).toMatchObject({
      p_version: 2,
      p_session: "2025/2026",
      p_valid_until: "2026-12-31T23:59:59.000Z",
      p_student_cap: 300,
      p_features: ["transport"],
    });
    expect(mocks.update.mock.calls.at(-1)![0]).toMatchObject({ license_pushed_version: 2 });
    expect(mocks.update.mock.calls.some((c) => "license_version" in c[0])).toBe(false);
  });

  it("accepts 'false' on a repeat (the school already has this version)", async () => {
    mocks.rpc.mockResolvedValue({ data: false, error: null });
    await expect(pushLicense(schoolId)).resolves.toBeUndefined();
  });

  it("refuses when no licence was ever set", async () => {
    mocks.single.mockResolvedValue({
      data: school({
        license_version: 0,
        license_session: null,
        license_valid_until: null,
        license_grace_until: null,
      }),
      error: null,
    });
    await expect(pushLicense(schoolId)).rejects.toThrow(/No licence has been set/);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("records the error and rethrows when the push fails", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "boom" } });
    await expect(pushLicense(schoolId)).rejects.toThrow(/boom/);
    expect(mocks.update.mock.calls.at(-1)![0]).toMatchObject({
      license_push_error: expect.stringContaining("boom"),
    });
  });
});

describe("revokeLicense", () => {
  beforeEach(() => mocks.requireActor.mockResolvedValue({ ...finance, role: "owner" }));

  it("needs the confirmation box", async () => {
    for (const confirm of [null, "", "no", undefined]) {
      await expect(revokeLicense(schoolId, confirm, now)).rejects.toThrow(/confirm/);
    }
    expect(mocks.withAudit).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("ends validity and grace now, keeps the rest, and pushes a higher version", async () => {
    const { version } = await revokeLicense(schoolId, "yes", now);
    expect(version).toBe(3);
    expect(audited[0]).toMatchObject({ action: "license.revoke", details: { from_version: 2 } });
    expect(mocks.rpc.mock.calls[0][1]).toMatchObject({
      p_version: 3,
      p_valid_until: now.toISOString(),
      p_grace_until: now.toISOString(),
      p_session: "2025/2026",
      p_student_cap: 300,
      p_features: ["transport"],
    });
  });
});
