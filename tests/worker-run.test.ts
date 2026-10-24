import { describe, expect, it, vi } from "vitest";
import { EnvSecrets } from "@/worker/secrets";
import { runWorker, tick, type WorkerDeps } from "@/worker/run";
import { fakeStore, job } from "@/tests/helpers/fake-store";

const secrets = new EnvSecrets(
  JSON.stringify({ greenfield: "postgres://u:supersecret1@h.example.com/db" })
);

function workerDeps(
  store: ReturnType<typeof fakeStore>,
  over: Partial<WorkerDeps> = {}
): WorkerDeps {
  return {
    workerId: "w1",
    store,
    secrets,
    connect: vi.fn(),
    deploy: vi.fn(),
    probe: vi.fn(),
    log: () => {},
    heartbeatMs: 5,
    ...over,
  };
}

describe("tick", () => {
  it("returns false and does nothing when the queue is empty", async () => {
    const store = fakeStore();
    expect(await tick(workerDeps(store))).toBe(false);
    expect(store.finishJob).not.toHaveBeenCalled();
    expect(store.claimJob).toHaveBeenCalledWith("w1", ["rollout_step", "schema_scan"]);
  });

  it("finishes a job that the handler says failed, with its error", async () => {
    const store = fakeStore({ claimJob: vi.fn(async () => job({ payload: {} })) });
    expect(await tick(workerDeps(store))).toBe(true);
    expect(store.finishJob).toHaveBeenCalledWith(
      "job-1",
      "w1",
      false,
      null,
      "The job has no step_id."
    );
    expect(store.retryJob).not.toHaveBeenCalled();
  });

  it("fails a job of an unknown type instead of retrying it forever", async () => {
    const store = fakeStore({ claimJob: vi.fn(async () => job({ type: "mystery" })) });
    await tick(workerDeps(store));
    expect(store.finishJob).toHaveBeenCalledWith(
      "job-1",
      "w1",
      false,
      null,
      expect.stringMatching(/Unknown job type/)
    );
  });

  it("puts a job back with a delay when something unexpected throws, and redacts secrets", async () => {
    const store = fakeStore({
      claimJob: vi.fn(async () => job()),
      loadStep: vi.fn(async () => {
        throw new Error("fetch failed for postgres://u:supersecret1@h.example.com/db");
      }),
    });
    await tick(workerDeps(store));
    expect(store.finishJob).not.toHaveBeenCalled();
    expect(store.retryJob).toHaveBeenCalledTimes(1);
    const [jobId, worker, message, delay] = (store.retryJob as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect([jobId, worker, delay]).toEqual(["job-1", "w1", 30]);
    expect(message).not.toContain("supersecret1");
  });

  it("survives a failure to requeue", async () => {
    const store = fakeStore({
      claimJob: vi.fn(async () => job()),
      loadStep: vi.fn(async () => {
        throw new Error("boom");
      }),
      retryJob: vi.fn(async () => {
        throw new Error("also down");
      }),
    });
    await expect(tick(workerDeps(store))).resolves.toBe(true);
  });

  it("keeps the job alive with heartbeats while a handler runs, then stops", async () => {
    const store = fakeStore({
      claimJob: vi.fn(async () => job()),
      loadStep: vi.fn(async () => {
        await new Promise((r) => setTimeout(r, 40));
        return null;
      }),
    });
    await tick(workerDeps(store));
    const during = (store.touchJob as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(during).toBeGreaterThanOrEqual(2);
    await new Promise((r) => setTimeout(r, 30));
    expect((store.touchJob as ReturnType<typeof vi.fn>).mock.calls.length).toBe(during);
  });
});

describe("runWorker", () => {
  const opts = (signal: AbortSignal) => ({
    pollMs: 5,
    staleMinutes: 45,
    scanEveryMs: 60_000,
    signal,
  });

  it("requeues stale jobs and queues scans first, then polls until stopped", async () => {
    const controller = new AbortController();
    let polls = 0;
    const store = fakeStore({
      claimJob: vi.fn(async () => {
        if (++polls >= 3) controller.abort();
        return null;
      }),
    });
    await runWorker(workerDeps(store), opts(controller.signal));
    expect(store.requeueStale).toHaveBeenCalledWith(45);
    expect(store.enqueueScans).toHaveBeenCalledTimes(1);
    expect(polls).toBe(3);
  });

  it("does not poll at all when already stopped", async () => {
    const controller = new AbortController();
    controller.abort();
    const store = fakeStore();
    await runWorker(workerDeps(store), opts(controller.signal));
    expect(store.claimJob).not.toHaveBeenCalled();
  });

  it("finishes the job in hand before stopping", async () => {
    const controller = new AbortController();
    const store = fakeStore({
      claimJob: vi.fn(async () => {
        controller.abort(); // stop requested while a job is claimed
        return job({ type: "mystery" });
      }),
    });
    await runWorker(workerDeps(store), opts(controller.signal));
    expect(store.finishJob).toHaveBeenCalledTimes(1);
  });

  it("still claims jobs when housekeeping keeps failing, and says so", async () => {
    const controller = new AbortController();
    let n = 0;
    const logs: string[] = [];
    const store = fakeStore({
      requeueStale: vi.fn(async () => {
        throw new Error("control plane unreachable");
      }),
      enqueueScans: vi.fn(async () => {
        throw new Error("scan scheduling broken");
      }),
      claimJob: vi.fn(async () => {
        if (++n >= 2) controller.abort();
        return null;
      }),
    });
    await runWorker(workerDeps(store, { log: (m) => logs.push(m) }), opts(controller.signal));
    expect(n).toBe(2);
    expect(
      logs.some((l) => /requeue of stale jobs failed: control plane unreachable/.test(l))
    ).toBe(true);
    expect(logs.some((l) => /schema scan scheduling failed: scan scheduling broken/.test(l))).toBe(
      true
    );
  });

  it("keeps going after the claim itself fails", async () => {
    const controller = new AbortController();
    let n = 0;
    const logs: string[] = [];
    const store = fakeStore({
      claimJob: vi.fn(async () => {
        if (++n === 1) throw new Error("claim failed");
        controller.abort();
        return null;
      }),
    });
    await runWorker(workerDeps(store, { log: (m) => logs.push(m) }), {
      ...opts(controller.signal),
      pollMs: 1,
    });
    expect(n).toBe(2);
    expect(logs.some((l) => /worker loop error: claim failed/.test(l))).toBe(true);
  });
});
