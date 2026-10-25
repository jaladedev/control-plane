import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireActor: vi.fn(),
  withAudit: vi.fn(),
  rpc: vi.fn(),
  rows: {} as Record<string, unknown>,
}));

vi.mock("@/lib/auth/guards", () => ({ requireActor: mocks.requireActor }));
vi.mock("@/lib/audit", () => ({ withAudit: mocks.withAudit }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => ({
    rpc: mocks.rpc,
    from: (table: string) => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: mocks.rows[table] ?? null, error: null }) }),
      }),
    }),
  })),
}));

import { createSchoolRollout, registerRelease, rollbackSchool } from "@/lib/actions/rollouts";

const owner = { id: "11111111-1111-4111-8111-111111111111", email: "o@example.com", role: "owner" };
const release = "22222222-2222-4222-8222-222222222222";
const school = "33333333-3333-4333-8333-333333333333";
const TAG = "a".repeat(40);

let audited: Array<{ action: string; schoolId?: string | null; details?: Record<string, unknown> }>;
let order: string[];

beforeEach(() => {
  Object.values(mocks).forEach((m) => typeof m === "function" && m.mockReset());
  audited = [];
  order = [];
  mocks.rows = { schools: { slug: "greenfield" }, releases: { image_tag: TAG } };
  mocks.requireActor.mockResolvedValue(owner);
  mocks.withAudit.mockImplementation(
    async (_a, entry, fn) => (audited.push(entry), order.push("audit"), fn())
  );
  mocks.rpc.mockImplementation(
    async (name: string) => (order.push(`rpc:${name}`), { data: "result-id", error: null })
  );
});

describe("owner only, and nothing happens when refused", () => {
  const denied = Object.assign(new Error("Your role cannot do this."), { code: "forbidden" });
  it.each([
    ["createSchoolRollout", () => createSchoolRollout(release, school, "greenfield")],
    ["rollbackSchool", () => rollbackSchool(school, "greenfield")],
    ["registerRelease", () => registerRelease(TAG)],
  ])("%s", async (_n, call) => {
    mocks.requireActor.mockRejectedValue(denied);
    await expect(call()).rejects.toThrow(/role cannot/);
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(audited).toEqual([]);
  });
  it("asks for the owner role", async () => {
    await rollbackSchool(school, "greenfield");
    expect(mocks.requireActor).toHaveBeenCalledWith(["owner"]);
  });
});

describe("createSchoolRollout", () => {
  it("audits first, then starts a rollout of exactly that school", async () => {
    expect(await createSchoolRollout(release, school, "greenfield")).toEqual({ id: "result-id" });
    expect(order).toEqual(["audit", "rpc:create_school_rollout"]);
    expect(audited[0]).toMatchObject({
      action: "rollout.create_school",
      schoolId: school,
      details: { release_id: release, image_tag: TAG, slug: "greenfield" },
    });
    expect(mocks.rpc).toHaveBeenCalledWith("create_school_rollout", {
      p_release: release,
      p_school: school,
      p_by: "o@example.com",
    });
  });
  it("needs the school's own name typed exactly, before any audit row", async () => {
    for (const confirm of ["", "Greenfield", "greenfield school", undefined, "ALL"]) {
      await expect(createSchoolRollout(release, school, confirm)).rejects.toThrow(
        /type the school's name \(greenfield\) exactly/
      );
    }
    expect(audited).toEqual([]);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("refuses ids that are not uuids, and a missing school or release", async () => {
    await expect(createSchoolRollout("x", school, "greenfield")).rejects.toThrow();
    await expect(createSchoolRollout(release, "y", "greenfield")).rejects.toThrow();
    mocks.rows.schools = null;
    await expect(createSchoolRollout(release, school, "greenfield")).rejects.toThrow(
      /school does not exist/
    );
    mocks.rows = { schools: { slug: "greenfield" }, releases: null };
    await expect(createSchoolRollout(release, school, "greenfield")).rejects.toThrow(
      /release does not exist/
    );
  });
  it("passes the database's reason through when it refuses", async () => {
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { message: "greenfield already runs this release." },
    });
    await expect(createSchoolRollout(release, school, "greenfield")).rejects.toThrow(
      "greenfield already runs this release."
    );
  });
});

describe("rollbackSchool", () => {
  it("audits against the school, then queues the rollback job", async () => {
    expect(await rollbackSchool(school, "greenfield")).toEqual({ jobId: "result-id" });
    expect(order).toEqual(["audit", "rpc:queue_school_rollback"]);
    expect(audited[0]).toMatchObject({
      action: "school.rollback",
      schoolId: school,
      details: { slug: "greenfield" },
    });
    expect(mocks.rpc).toHaveBeenCalledWith("queue_school_rollback", {
      p_school: school,
      p_by: "o@example.com",
    });
  });
  it("needs the school's name, and a real school", async () => {
    await expect(rollbackSchool(school, "yes")).rejects.toThrow(/type the school's name/);
    mocks.rows.schools = null;
    await expect(rollbackSchool(school, "greenfield")).rejects.toThrow(/does not exist/);
    expect(audited).toEqual([]);
  });
  it("passes the database's reason through (a rollout in progress, a duplicate)", async () => {
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { message: "greenfield is being rolled out right now. Wait for that step to finish." },
    });
    await expect(rollbackSchool(school, "greenfield")).rejects.toThrow(
      /being rolled out right now/
    );
  });
});

describe("registerRelease", () => {
  it("lowercases a pasted hash, audits it as a dashboard registration and queues the job", async () => {
    await registerRelease(`  ${"A".repeat(40)} `, "hotfix for login");
    expect(order).toEqual(["audit", "rpc:queue_register_release"]);
    expect(audited[0]).toMatchObject({
      action: "release.register",
      details: { tag: TAG, via: "dashboard", notes: "hotfix for login" },
    });
    expect(mocks.rpc).toHaveBeenCalledWith("queue_register_release", {
      p_tag: TAG,
      p_notes: "hotfix for login",
      p_by: "o@example.com",
    });
  });
  it("treats blank notes as none", async () => {
    await registerRelease(TAG, "");
    expect(mocks.rpc).toHaveBeenCalledWith("queue_register_release", {
      p_tag: TAG,
      p_notes: null,
      p_by: "o@example.com",
    });
  });
  it("refuses a branch name, a short hash and over-long notes before anything is written", async () => {
    for (const bad of ["main", "abc123", "g".repeat(40), undefined])
      await expect(registerRelease(bad)).rejects.toThrow();
    await expect(registerRelease(TAG, "x".repeat(501))).rejects.toThrow(/at most 500/);
    expect(audited).toEqual([]);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
