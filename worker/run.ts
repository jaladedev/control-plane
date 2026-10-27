import {
  handleRolloutStep,
  handleSchemaScan,
  type HandlerDeps,
  handleLicensePush,
  handleRegisterRelease,
  handleTelegramNotify,
  handleSchoolRollback,
  type HandlerResult,
} from "@/worker/handlers";

// The worker loop. A job is claimed (SKIP LOCKED in SQL), kept alive with a
// heartbeat while it runs, and finished. A job that raises an unexpected error
// is put back for another try (retry_job); the database fails it for good
// after its attempts are used up.

export type WorkerDeps = HandlerDeps & { workerId: string; heartbeatMs?: number };

export const JOB_TYPES = [
  "rollout_step",
  "schema_scan",
  "school_rollback",
  "register_release",
  "license_push",
  "telegram_notify",
];

/** Processes at most one job. Returns false when the queue was empty. */
export async function tick(deps: WorkerDeps): Promise<boolean> {
  const { store, workerId, log } = deps;
  const job = await store.claimJob(workerId, JOB_TYPES);
  if (!job) return false;

  const beat = setInterval(() => {
    store.touchJob(job.id, workerId).catch(() => {});
  }, deps.heartbeatMs ?? 60_000);

  try {
    log(`job ${job.id} ${job.type} (attempt ${job.attempts}/${job.max_attempts})`);
    let out: HandlerResult;
    if (job.type === "rollout_step") out = await handleRolloutStep(job, deps);
    else if (job.type === "schema_scan") out = await handleSchemaScan(job, deps);
    else if (job.type === "school_rollback") out = await handleSchoolRollback(job, deps);
    else if (job.type === "register_release") out = await handleRegisterRelease(job, deps);
    else if (job.type === "license_push") out = await handleLicensePush(job, deps);
    else if (job.type === "telegram_notify") out = await handleTelegramNotify(job, deps);
    else out = { ok: false, error: `Unknown job type ${job.type}.` };
    await store.finishJob(job.id, workerId, out.ok, out.result ?? null, out.error ?? null);
    log(`job ${job.id} ${out.ok ? "succeeded" : `failed: ${out.error}`}`);
  } catch (error) {
    const message = deps.secrets.redact(error instanceof Error ? error.message : String(error));
    log(`job ${job.id} hit an error and will be retried: ${message}`);
    await store
      .retryJob(job.id, workerId, message.slice(0, 500), 30)
      .catch((e) => log(`could not requeue ${job.id}: ${e}`));
  } finally {
    clearInterval(beat);
  }
  return true;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done);
  });

export type LoopOptions = {
  pollMs: number;
  staleMinutes: number;
  scanEveryMs: number;
  /** Suspend schools whose licence ended this many days ago. Absent or null: never. */
  autoSuspendAfterDays?: number | null;
  signal: AbortSignal;
};

/** Runs until the signal aborts; an in-flight job finishes first. */
export async function runWorker(deps: WorkerDeps, opts: LoopOptions): Promise<void> {
  let lastStale = 0;
  let lastScan = 0;
  let lastReminders = 0;
  let lastSuspendCheck = 0;
  // Housekeeping must never stand between the worker and its jobs: a failure
  // is logged and tried again next interval, and the loop carries on.
  const housekeeping = async (name: string, due: boolean, fn: () => Promise<void>) => {
    if (!due) return;
    try {
      await fn();
    } catch (error) {
      deps.log(`${name} failed: ${error instanceof Error ? error.message : error}`);
    }
  };
  while (!opts.signal.aborted) {
    try {
      const now = Date.now();
      await housekeeping("requeue of stale jobs", now - lastStale >= 60_000, async () => {
        lastStale = now;
        const n = await deps.store.requeueStale(opts.staleMinutes);
        if (n > 0) deps.log(`requeued ${n} stale job(s)`);
      });
      await housekeeping("schema scan scheduling", now - lastScan >= opts.scanEveryMs, async () => {
        lastScan = now;
        const n = await deps.store.enqueueScans();
        if (n > 0) deps.log(`queued ${n} schema scan(s)`);
      });
      await housekeeping("claim reminders", now - lastReminders >= 10 * 60_000, async () => {
        lastReminders = now;
        const n = await deps.store.enqueueClaimReminders();
        if (n > 0) deps.log(`queued ${n} claim reminder(s)`);
      });
      const afterDays = opts.autoSuspendAfterDays;
      await housekeeping(
        "automatic suspension",
        afterDays != null && now - lastSuspendCheck >= 60 * 60_000,
        async () => {
          lastSuspendCheck = now;
          const suspended = await deps.store.suspendLapsedSchools(afterDays!);
          for (const school of suspended) {
            deps.log(
              `suspended ${school.slug}: its licence ended ${school.graceUntil}, more than ${afterDays} days ago`
            );
            // A notice that cannot be sent never undoes the suspension.
            try {
              await deps.telegram?.send(
                `School suspended for a lapsed licence: ${school.slug}\n` +
                  `Its licence (grace included) ended ${school.graceUntil.slice(0, 10)}. ` +
                  `A confirmed payment lifts this automatically.`
              );
            } catch (error) {
              deps.log(
                `suspension notice failed: ${error instanceof Error ? error.message : error}`
              );
            }
          }
        }
      );
      if (!(await tick(deps))) await sleep(opts.pollMs, opts.signal);
    } catch (error) {
      deps.log(`worker loop error: ${error instanceof Error ? error.message : error}`);
      await sleep(Math.min(opts.pollMs * 5, 30_000), opts.signal);
    }
  }
}
