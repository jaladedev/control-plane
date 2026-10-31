import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireActor: vi.fn(),
  withAudit: vi.fn(),
  rpc: vi.fn(),
  update: vi.fn(),
  school: null as Record<string, unknown> | null,
}));

vi.mock("@/lib/auth/guards", () => ({ requireActor: mocks.requireActor }));
vi.mock("@/lib/audit", () => ({ withAudit: mocks.withAudit }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => ({
    rpc: mocks.rpc,
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: mocks.school, error: null }) }),
      }),
      update: (values: unknown) => ({
        eq: async () => (mocks.update(values), { error: null }),
      }),
    }),
  })),
}));

import { startProvisioning } from "@/lib/actions/provision";

const owner = { id: "11111111-1111-4111-8111-111111111111", email: "o@example.com", role: "owner" };
const id = "33333333-3333-4333-8333-333333333333";
const now = new Date("2026-10-31T10:00:00Z");
const form = {
  kind: "trial",
  session: "2026/2027",
  valid_until: "2026-12-01",
  grace_days: "14",
  admin_name: "Ada Obi",
  admin_email: "Ada@Example.com",
};

let audited: Array<{ action: string; schoolId?: string | null; details?: Record<string, unknown> }>;
let order: string[];

beforeEach(() => {
  Object.values(mocks).forEach((m) => typeof m === "function" && m.mockReset());
  audited = [];
  order = [];
  mocks.school = {
    id,
    slug: "greenfield",
    status: "provisioning",
    included_students: 300,
    features: ["messaging"],
    license_version: 0,
  };
  mocks.requireActor.mockResolvedValue(owner);
  mocks.withAudit.mockImplementation(
    async (_a, entry, fn) => (audited.push(entry), order.push("audit"), fn())
  );
  mocks.update.mockImplementation(() => order.push("save licence"));
  mocks.rpc.mockImplementation(
    async (name: string) => (order.push(`rpc:${name}`), { data: "job-1", error: null })
  );
});

describe("startProvisioning", () => {
  it("is for owners only, and does nothing when refused", async () => {
    mocks.requireActor.mockRejectedValue(
      Object.assign(new Error("Your role cannot do this."), { code: "forbidden" })
    );
    await expect(startProvisioning(id, form, now)).rejects.toThrow(/role cannot/);
    expect(mocks.requireActor).toHaveBeenCalledWith(["owner"]);
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(audited).toEqual([]);
  });

  it("writes the audit row first, then saves the licence, then queues the job", async () => {
    const out = await startProvisioning(id, form, now);
    expect(out).toEqual({ jobId: "job-1" });
    expect(order).toEqual(["audit", "save licence", "save licence", "rpc:queue_provision"]);
    expect(mocks.rpc).toHaveBeenCalledWith("queue_provision", {
      p_school: id,
      p_by: "o@example.com",
    });
  });

  it("saves the first licence as version 1, with the school's own cap and add-ons", async () => {
    await startProvisioning(id, { ...form, student_cap: "99999", features: "hacked" }, now);
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({
        license_version: 1,
        license_session: "2026/2027",
        license_is_trial: true,
        license_valid_until: "2026-12-01T23:59:59.000Z",
        license_grace_until: "2026-12-15T23:59:59.000Z",
        license_push_error: null,
      })
    );
    expect(audited[0]).toMatchObject({
      action: "school.provision",
      schoolId: id,
      details: {
        slug: "greenfield",
        resume: false,
        license: { student_cap: 300, features: ["messaging"] },
      },
    });
  });

  it("saves the first admin with a lower-cased email, and audits it without the name", async () => {
    await startProvisioning(id, form, now);
    expect(mocks.update).toHaveBeenCalledWith({
      first_admin_name: "Ada Obi",
      first_admin_email: "ada@example.com",
    });
    expect(audited[0].details).toMatchObject({ first_admin_email: "ada@example.com" });
    expect(order).toEqual(["audit", "save licence", "save licence", "rpc:queue_provision"]);
  });

  it("refuses a first admin with a bad email, saving nothing", async () => {
    await expect(startProvisioning(id, { ...form, admin_email: "nope" }, now)).rejects.toThrow(
      /valid email/
    );
    await expect(
      startProvisioning(id, { ...form, admin_name: "", admin_email: "a@b.co" }, now)
    ).rejects.toThrow(/name/);
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("is a resume, with no licence change, when the form has no licence fields", async () => {
    mocks.school = { ...(mocks.school as object), license_version: 1 };
    await startProvisioning(id, {}, now);
    expect(mocks.update).not.toHaveBeenCalled();
    expect(order).toEqual(["audit", "rpc:queue_provision"]);
    expect(audited[0].details).toMatchObject({ resume: true });
  });

  it("refuses a school that is not being provisioned, before auditing or queueing", async () => {
    mocks.school = { ...(mocks.school as object), status: "active" };
    await expect(startProvisioning(id, form, now)).rejects.toThrow(/active/);
    expect(audited).toEqual([]);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("refuses an unknown school and a malformed id", async () => {
    mocks.school = null;
    await expect(startProvisioning(id, form, now)).rejects.toThrow(/does not exist/);
    await expect(startProvisioning("nope", form, now)).rejects.toThrow();
  });

  it("refuses a licence ending in the past or with no session, and saves nothing", async () => {
    await expect(
      startProvisioning(id, { ...form, valid_until: "2026-01-01" }, now)
    ).rejects.toThrow(/past/);
    await expect(startProvisioning(id, { ...form, session: "" }, now)).rejects.toThrow(/session/);
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("passes the database's refusal through as it is", async () => {
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { message: "No release is registered, so there is nothing to deploy." },
    });
    await expect(startProvisioning(id, form, now)).rejects.toThrow(/No release is registered/);
  });
});
