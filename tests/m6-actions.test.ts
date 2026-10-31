import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireActor: vi.fn(),
  withAudit: vi.fn(),
  rpc: vi.fn(),
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
    }),
  })),
}));

import { applySchoolSettings } from "@/lib/actions/rollouts";
import { recordRestoreDrill } from "@/lib/actions/drills";

const owner = { id: "11111111-1111-4111-8111-111111111111", email: "o@example.com", role: "owner" };
const school = "33333333-3333-4333-8333-333333333333";
const backup = "44444444-4444-4444-8444-444444444444";
const denied = Object.assign(new Error("Your role cannot do this."), { code: "forbidden" });
let audited: Array<{ action: string; schoolId?: string | null; details?: Record<string, unknown> }>;
let order: string[];

beforeEach(() => {
  Object.values(mocks).forEach((m) => typeof m === "function" && m.mockReset());
  audited = [];
  order = [];
  mocks.school = { slug: "greenfield" };
  mocks.requireActor.mockResolvedValue(owner);
  mocks.withAudit.mockImplementation(
    async (_a, entry, fn) => (audited.push(entry), order.push("audit"), fn())
  );
  mocks.rpc.mockImplementation(
    async (name: string) => (order.push(`rpc:${name}`), { data: "id-1", error: null })
  );
});

describe("applySchoolSettings", () => {
  it("is for owners only, and does nothing when refused", async () => {
    mocks.requireActor.mockRejectedValue(denied);
    await expect(applySchoolSettings(school, "greenfield")).rejects.toThrow(/role cannot/);
    expect(mocks.requireActor).toHaveBeenCalledWith(["owner"]);
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(audited).toEqual([]);
  });

  it("needs the school's name typed exactly, and queues nothing without it", async () => {
    for (const typed of ["", "Greenfield", "other", undefined, null]) {
      await expect(applySchoolSettings(school, typed)).rejects.toThrow(
        /type the school's name \(greenfield\)/
      );
    }
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(audited).toEqual([]);
  });

  it("audits first, then queues, naming who asked, and puts no value in the audit row", async () => {
    expect(await applySchoolSettings(school, " greenfield ")).toEqual({ jobId: "id-1" });
    expect(order).toEqual(["audit", "rpc:queue_reconfigure"]);
    expect(mocks.rpc).toHaveBeenCalledWith("queue_reconfigure", {
      p_school: school,
      p_by: "o@example.com",
    });
    expect(audited[0]).toEqual({
      action: "school.apply_settings",
      schoolId: school,
      details: { slug: "greenfield" },
    });
  });

  it("refuses an unknown school or a malformed id, and passes the database's refusal through", async () => {
    mocks.school = null;
    await expect(applySchoolSettings(school, "greenfield")).rejects.toThrow(/does not exist/);
    await expect(applySchoolSettings("nope", "greenfield")).rejects.toThrow();
    mocks.school = { slug: "greenfield" };
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { message: "Another operation on greenfield is already queued or running." },
    });
    await expect(applySchoolSettings(school, "greenfield")).rejects.toThrow(
      /already queued or running/
    );
  });
});

describe("recordRestoreDrill", () => {
  const form = {
    schoolId: school,
    backupId: backup,
    ok: "true",
    minutes: "12.5",
    notes: " worked ",
  };

  it("is for owners only", async () => {
    mocks.requireActor.mockRejectedValue(denied);
    await expect(recordRestoreDrill(form)).rejects.toThrow(/role cannot/);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("audits first, then records, with minutes turned into seconds", async () => {
    expect(await recordRestoreDrill(form)).toEqual({ id: "id-1" });
    expect(order).toEqual(["audit", "rpc:record_restore_drill"]);
    expect(mocks.rpc).toHaveBeenCalledWith("record_restore_drill", {
      p_school: school,
      p_backup: backup,
      p_ok: true,
      p_seconds: 750,
      p_notes: "worked",
      p_by: "o@example.com",
    });
    expect(audited[0]).toMatchObject({
      action: "restore.drill_record",
      schoolId: school,
      details: { slug: "greenfield", ok: true, seconds: 750, backup_id: backup },
    });
  });

  it("records a failed drill, and a drill of the control plane's own backup (no school)", async () => {
    await recordRestoreDrill({ ...form, ok: "false", backupId: "", notes: "" });
    expect(mocks.rpc).toHaveBeenLastCalledWith(
      "record_restore_drill",
      expect.objectContaining({ p_ok: false, p_backup: null, p_notes: null })
    );
    await recordRestoreDrill({ schoolId: "", backupId: "", ok: "true", minutes: "3" });
    expect(mocks.rpc).toHaveBeenLastCalledWith(
      "record_restore_drill",
      expect.objectContaining({ p_school: null, p_ok: true })
    );
    expect(audited.at(-1)?.details).toMatchObject({ slug: "control-plane" });
  });

  it.each([
    [{ minutes: "-1" }, /negative/],
    [{ minutes: "2000" }, /at most 1440/],
    [{ minutes: "abc" }, /./],
    [{ schoolId: "nope" }, /./],
    [{ backupId: "nope" }, /./],
    [{ notes: "x".repeat(1001) }, /at most 1000/],
  ])("refuses %j, recording nothing", async (bad, message) => {
    await expect(recordRestoreDrill({ ...form, ...bad })).rejects.toThrow(message);
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(audited).toEqual([]);
  });

  it("refuses an unknown school", async () => {
    mocks.school = null;
    await expect(recordRestoreDrill(form)).rejects.toThrow(/does not exist/);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("passes the database's refusal through", async () => {
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { message: "That backup belongs to another school." },
    });
    await expect(recordRestoreDrill(form)).rejects.toThrow(/another school/);
  });
});
