import { vi } from "vitest";
import type { RunnerMigration } from "@/lib/migrate/runner";
import type { Job, SchoolPatch, Store, StepContext } from "@/worker/store";

// An in-memory Store: records every call so tests can assert on order and
// content. State machine rules are tested in SQL, not here.
export function fakeStore(overrides: Partial<Store> = {}) {
  const calls: string[] = [];
  const note = (name: string) => calls.push(name);
  const patches: SchoolPatch[] = [];
  const runs: { id: string; migrationId: string; status: string; error?: string }[] = [];
  const completions: { stepId: string; ok: boolean; result: unknown; error: string | null }[] = [];

  const store: Store & {
    calls: string[];
    patches: SchoolPatch[];
    runs: typeof runs;
    completions: typeof completions;
  } = {
    calls,
    patches,
    runs,
    completions,
    claimJob: vi.fn(async () => null),
    touchJob: vi.fn(async () => true),
    finishJob: vi.fn(async () => {}),
    retryJob: vi.fn(async () => {}),
    requeueStale: vi.fn(async () => 0),
    enqueueScans: vi.fn(async () => 0),
    loadStep: vi.fn(async (): Promise<StepContext | null> => null),
    startStep: vi.fn(async () => true),
    completeStep: vi.fn(async (stepId, ok, result, error) => {
      note("completeStep");
      completions.push({ stepId, ok, result, error });
    }),
    registeredMigrations: vi.fn(async (): Promise<RunnerMigration[]> => []),
    releaseSeqs: vi.fn(async () => new Map<string, number>()),
    schoolForScan: vi.fn(async () => null),
    reconcileRuns: vi.fn(async () => {}),
    startRun: vi.fn(async (_school, _step, migrationId) => {
      runs.push({ id: `run-${runs.length}`, migrationId, status: "running" });
      return `run-${runs.length - 1}`;
    }),
    finishRun: vi.fn(async (runId, ok, error) => {
      const run = runs[Number(runId.split("-")[1])];
      run.status = ok ? "succeeded" : "failed";
      run.error = error;
    }),
    updateSchool: vi.fn(async (_id, patch) => {
      note("updateSchool");
      patches.push(patch);
    }),
    ...overrides,
  };
  return store;
}

export const job = (over: Partial<Job> = {}): Job => ({
  id: "job-1",
  type: "rollout_step",
  school_id: "school-1",
  payload: { rollout_id: "r1", step_id: "step-1" },
  attempts: 1,
  max_attempts: 3,
  ...over,
});
