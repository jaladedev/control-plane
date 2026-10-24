import { describe, expect, it } from "vitest";
import {
  appState,
  availableControls,
  pendingCount,
  planPreview,
  progress,
  stalledQueueSeconds,
  type SchoolInfo,
  type StepInfo,
} from "@/lib/rollout-view";

const school = (slug: string, over: Partial<SchoolInfo> = {}): SchoolInfo => ({
  id: slug,
  slug,
  name: slug,
  status: "active",
  rollout_group: "standard",
  hostnames: [`${slug}.example.com`],
  supabase_project_ref: `ref${slug}`,
  ...over,
});

describe("planPreview", () => {
  it("counts who would be included, by group", () => {
    const p = planPreview([
      school("a", { rollout_group: "test" }),
      school("b", { rollout_group: "pilot" }),
      school("c"),
      school("d"),
    ]);
    expect(p.included).toEqual({ test: 1, pilot: 1, standard: 2 });
    expect(p.excluded).toEqual([]);
  });
  it("leaves out and explains schools that cannot be rolled out, and ignores archived ones", () => {
    const p = planPreview([
      school("susp", { status: "suspended" }),
      school("nohost", { hostnames: [] }),
      school("noref", { supabase_project_ref: null }),
      school("gone", { status: "archived" }),
      school("ok"),
    ]);
    expect(p.included.standard).toBe(1);
    expect(p.excluded).toEqual([
      { slug: "susp", reason: "status is suspended" },
      { slug: "nohost", reason: "no hostname" },
      { slug: "noref", reason: "no Supabase project ref" },
    ]);
  });
});

describe("pendingCount", () => {
  const registered = ["20261001000000", "20261002000000", "20261003000000"];
  it("counts registered migrations newer than the school's version", () => {
    expect(pendingCount("20261001000000", registered)).toBe(2);
    expect(pendingCount("20261003000000", registered)).toBe(0);
  });
  it("is unknown when the school's version has not been read", () => {
    expect(pendingCount(null, registered)).toBeNull();
  });
});

describe("appState", () => {
  const seqs = new Map([
    ["a".repeat(40), 1],
    ["b".repeat(40), 2],
    ["c".repeat(40), 3],
  ]);
  it("is current at the latest release", () => {
    expect(appState("c".repeat(40), seqs, 3)).toEqual({ state: "current", by: 0 });
  });
  it("says how many releases behind", () => {
    expect(appState("a".repeat(40), seqs, 3)).toEqual({ state: "behind", by: 2 });
  });
  it("is unknown for an unregistered tag, no tag, or no releases", () => {
    expect(appState("f".repeat(40), seqs, 3).state).toBe("unknown");
    expect(appState(null, seqs, 3).state).toBe("unknown");
    expect(appState("a".repeat(40), seqs, null).state).toBe("unknown");
  });
});

// 1 test, 1 pilot, then batches of two: positions 1..6
const step = (
  position: number,
  stage: StepInfo["stage"],
  batch_no: number,
  status: StepInfo["status"] = "pending"
): StepInfo => ({ position, stage, batch_no, status });
const plan = (statuses: StepInfo["status"][] = []): StepInfo[] =>
  [
    step(1, "test", 0),
    step(2, "pilot", 0),
    step(3, "batch", 1),
    step(4, "batch", 1),
    step(5, "batch", 2),
    step(6, "batch", 2),
  ].map((s, i) => ({ ...s, status: statuses[i] ?? "pending" }));

describe("availableControls", () => {
  const running = (released_through: number) => ({ status: "running", released_through });
  const none = { test: false, pilot: false, next_batch: false, all: false, waiting: false };

  it("offers only the test school at the start", () => {
    expect(availableControls(running(0), plan())).toEqual({ ...none, test: true });
  });
  it("offers nothing while a released school is unfinished, and says it is waiting", () => {
    expect(availableControls(running(1), plan(["running"]))).toEqual({ ...none, waiting: true });
    expect(availableControls(running(1), plan(["queued"]))).toEqual({ ...none, waiting: true });
  });
  it("offers the pilot once the test school succeeded", () => {
    expect(availableControls(running(1), plan(["succeeded"]))).toEqual({ ...none, pilot: true });
  });
  it("offers batches and all once test and pilot succeeded", () => {
    expect(availableControls(running(2), plan(["succeeded", "succeeded"]))).toEqual({
      ...none,
      next_batch: true,
      all: true,
    });
  });
  it("offers the next batch and all after the first batch", () => {
    expect(
      availableControls(running(4), plan(["succeeded", "succeeded", "succeeded", "succeeded"]))
    ).toEqual({ ...none, next_batch: true, all: true });
  });
  it("offers nothing when everything is released and done", () => {
    expect(availableControls(running(6), plan(Array(6).fill("succeeded")))).toEqual(none);
  });
  it("offers nothing for a halted, cancelled or finished rollout", () => {
    for (const status of ["halted", "cancelled", "succeeded"]) {
      expect(availableControls({ status, released_through: 1 }, plan(["failed"]))).toEqual(none);
    }
  });
  it("does not offer the pilot when there is none", () => {
    const noPilot = [step(1, "test", 0, "succeeded"), step(2, "batch", 1)];
    expect(availableControls(running(1), noPilot)).toEqual({
      ...none,
      next_batch: true,
      all: true,
    });
  });
});

describe("progress", () => {
  it("counts done, failed and active steps", () => {
    expect(progress(plan(["succeeded", "failed", "running", "queued"]))).toEqual({
      total: 6,
      done: 1,
      failed: 1,
      active: 2,
    });
  });
});

describe("stalledQueueSeconds", () => {
  const now = new Date("2026-10-24T12:00:00Z");
  const job = (agoSeconds: number, runAfterSeconds = agoSeconds) => ({
    created_at: new Date(now.getTime() - agoSeconds * 1000).toISOString(),
    run_after: new Date(now.getTime() - runAfterSeconds * 1000).toISOString(),
  });
  it("is null when nothing is queued or the queue is fresh", () => {
    expect(stalledQueueSeconds([], now)).toBeNull();
    expect(stalledQueueSeconds([job(30)], now)).toBeNull();
  });
  it("reports the oldest due job once it has waited two minutes", () => {
    expect(stalledQueueSeconds([job(30), job(300)], now)).toBe(300);
  });
  it("ignores a job that is waiting on purpose for its run_after time", () => {
    expect(stalledQueueSeconds([job(600, -60)], now)).toBeNull();
  });
});
