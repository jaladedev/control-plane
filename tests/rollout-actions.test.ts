import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireActor: vi.fn(),
  withAudit: vi.fn(),
  rpc: vi.fn(),
  maybeSingle: vi.fn(),
}));

vi.mock("@/lib/auth/guards", () => ({ requireActor: mocks.requireActor }));
vi.mock("@/lib/audit", () => ({ withAudit: mocks.withAudit }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => ({
    rpc: mocks.rpc,
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: mocks.maybeSingle }) }) }),
  })),
}));

import {
  cancelRollout,
  createRollout,
  releaseRollout,
  requestSchemaScan,
  retryStep,
} from "@/lib/actions/rollouts";

const owner = { id: "11111111-1111-4111-8111-111111111111", email: "o@example.com", role: "owner" };
const id = "22222222-2222-4222-8222-222222222222";
const other = "33333333-3333-4333-8333-333333333333";

let audited: Array<{ action: string; schoolId?: string | null; details?: Record<string, unknown> }>;
let order: string[];

beforeEach(() => {
  Object.values(mocks).forEach((m) => m.mockReset());
  audited = [];
  order = [];
  mocks.requireActor.mockResolvedValue(owner);
  mocks.withAudit.mockImplementation(async (_actor, entry, fn) => {
    audited.push(entry);
    order.push("audit");
    return fn();
  });
  mocks.rpc.mockImplementation(async (name: string) => {
    order.push(`rpc:${name}`);
    return {
      data: name === "create_rollout" ? id : name === "enqueue_schema_scan" ? 3 : null,
      error: null,
    };
  });
  mocks.maybeSingle.mockResolvedValue({
    data: {
      image_tag: "a".repeat(40),
      rollout_id: id,
      school_id: other,
      schools: { slug: "greenfield" },
    },
    error: null,
  });
});

describe("every rollout action is owner-only and does nothing when refused", () => {
  const denied = Object.assign(new Error("Your role cannot do this."), { code: "forbidden" });
  it.each([
    ["createRollout", () => createRollout(id, 5)],
    ["releaseRollout", () => releaseRollout(id, "test")],
    ["retryStep", () => retryStep(id)],
    ["cancelRollout", () => cancelRollout(id, "yes")],
    ["requestSchemaScan", () => requestSchemaScan()],
  ])("%s", async (_name, call) => {
    mocks.requireActor.mockRejectedValue(denied);
    await expect(call()).rejects.toBe(denied);
    expect(mocks.requireActor).toHaveBeenCalledWith(["owner"]);
    expect(mocks.withAudit).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});

describe("createRollout", () => {
  it("audits first, then plans the rollout for the release", async () => {
    const out = await createRollout(id, "5");
    expect(out).toEqual({ id });
    expect(order).toEqual(["audit", "rpc:create_rollout"]);
    expect(audited[0]).toMatchObject({
      action: "rollout.create",
      details: { release_id: id, batch_size: 5, image_tag: "a".repeat(40) },
    });
    expect(mocks.rpc).toHaveBeenCalledWith("create_rollout", {
      p_release: id,
      p_batch_size: 5,
      p_by: "o@example.com",
    });
  });

  it.each(["0", "51", "abc", "2.5", ""])(
    "refuses a batch size of %j before writing anything",
    async (size) => {
      await expect(createRollout(id, size)).rejects.toThrow();
      expect(mocks.withAudit).not.toHaveBeenCalled();
    }
  );

  it("refuses a release that does not exist", async () => {
    mocks.maybeSingle.mockResolvedValue({ data: null, error: null });
    await expect(createRollout(id, 5)).rejects.toThrow(/does not exist/);
    expect(mocks.withAudit).not.toHaveBeenCalled();
  });

  it("passes the database's reason through", async () => {
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { message: "Mark at least one active school as the test school first." },
    });
    await expect(createRollout(id, 5)).rejects.toThrow(/test school first/);
  });
});

describe("releaseRollout", () => {
  it.each(["test", "pilot"])("releases %s without a confirmation word", async (target) => {
    await releaseRollout(id, target);
    expect(order).toEqual(["audit", "rpc:release_rollout"]);
    expect(mocks.rpc).toHaveBeenCalledWith("release_rollout", { p_rollout: id, p_target: target });
    expect(audited[0]).toMatchObject({
      action: "rollout.release",
      details: { rollout_id: id, target },
    });
  });

  it.each(["next_batch", "all"])("needs ALL typed for %s", async (target) => {
    for (const confirm of [undefined, "", "all", "All", "ALL ", "yes"]) {
      await expect(releaseRollout(id, target, confirm)).rejects.toThrow(/Type ALL/);
    }
    expect(mocks.withAudit).not.toHaveBeenCalled();
    await releaseRollout(id, target, "ALL");
    expect(mocks.rpc).toHaveBeenCalledWith("release_rollout", { p_rollout: id, p_target: target });
  });

  it("refuses an unknown target and a bad id before writing", async () => {
    await expect(releaseRollout(id, "everything", "ALL")).rejects.toThrow();
    await expect(releaseRollout("not-a-uuid", "test")).rejects.toThrow();
    expect(mocks.withAudit).not.toHaveBeenCalled();
  });

  it("passes the canary-order refusal through", async () => {
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { message: "Every test school must succeed before the pilot." },
    });
    await expect(releaseRollout(id, "pilot")).rejects.toThrow(/test school must succeed/);
  });
});

describe("retryStep", () => {
  it("audits against the step's school and names it", async () => {
    await retryStep(id);
    expect(audited[0]).toMatchObject({
      action: "rollout.retry_step",
      schoolId: other,
      details: { step_id: id, rollout_id: id, slug: "greenfield" },
    });
    expect(order).toEqual(["audit", "rpc:retry_step"]);
  });
  it("refuses an unknown step before writing", async () => {
    mocks.maybeSingle.mockResolvedValue({ data: null, error: null });
    await expect(retryStep(id)).rejects.toThrow(/does not exist/);
    expect(mocks.withAudit).not.toHaveBeenCalled();
  });
});

describe("cancelRollout", () => {
  it("needs the confirmation box", async () => {
    for (const c of [undefined, "", "no", null])
      await expect(cancelRollout(id, c)).rejects.toThrow(/confirm/);
    expect(mocks.withAudit).not.toHaveBeenCalled();
  });
  it("audits and cancels", async () => {
    await cancelRollout(id, "yes");
    expect(order).toEqual(["audit", "rpc:cancel_rollout"]);
  });
});

describe("requestSchemaScan", () => {
  it("scans every school, or one, and says how many were queued", async () => {
    expect(await requestSchemaScan()).toEqual({ queued: 3 });
    expect(mocks.rpc).toHaveBeenLastCalledWith("enqueue_schema_scan", { p_school: null });
    expect(audited[0]).toMatchObject({
      action: "schema.scan_request",
      schoolId: null,
      details: { all: true },
    });
    await requestSchemaScan(other);
    expect(mocks.rpc).toHaveBeenLastCalledWith("enqueue_schema_scan", { p_school: other });
    expect(audited[1]).toMatchObject({ schoolId: other, details: { all: false } });
  });
});
