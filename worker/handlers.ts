import {
  MigrationError,
  applyPendingMigrations,
  readAppliedVersions,
  readAppliedVersionsReadOnly,
  type PgLike,
} from "@/lib/migrate/runner";
import type { DeployCommand, DeployOutcome } from "@/lib/deploy/client";
import type { ProbeResult } from "@/lib/health";
import type { Job, SchoolPatch, Store } from "@/worker/store";
import type { SecretsProvider } from "@/worker/secrets";

// What the worker does for each kind of job. All I/O comes in through
// HandlerDeps, so these are tested with fakes; the real wiring is in
// worker/index.ts.

export type SchoolConnection = { db: PgLike; close: () => Promise<void> };

export type HandlerDeps = {
  store: Store;
  secrets: SecretsProvider;
  connect: (databaseUrl: string) => Promise<SchoolConnection>;
  deploy: (cmd: DeployCommand) => Promise<DeployOutcome>;
  /** Deep health probe of the school's first hostname. */
  probe: (hostname: string, slug: string) => Promise<ProbeResult>;
  log: (message: string) => void;
};

export type HandlerResult = { ok: boolean; result?: unknown; error?: string | null };

class StepFailure extends Error {
  constructor(
    message: string,
    public readonly partial: Record<string, unknown> = {}
  ) {
    super(message);
  }
}

const clip = (s: string, n = 800) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** Maps a connection failure to the school's credentials_status, if it says one. */
export function classifyConnectError(error: unknown): SchoolPatch["credentials_status"] | null {
  const code = (error as { code?: string } | null)?.code;
  const message = error instanceof Error ? error.message : String(error);
  if (code === "28P01" || code === "28000") return "auth_failed";
  if (
    ["ENOTFOUND", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "ECONNRESET", "EHOSTUNREACH"].includes(
      code ?? ""
    ) ||
    /timeout|timed out|terminated unexpectedly/i.test(message)
  ) {
    return "unreachable";
  }
  return null;
}

// One school, one release: migrate its database, deploy its container, check
// it is healthy, and record the result. Reports to the rollout through
// complete_step; any failure stops the rollout (in SQL), not here.
//
// Errors thrown BEFORE the step has started (loading it, starting it) are
// infrastructure problems: they propagate so the worker retries the job. After
// the step has started, every outcome is reported through complete_step.
export async function handleRolloutStep(job: Job, deps: HandlerDeps): Promise<HandlerResult> {
  const { store, secrets, log } = deps;
  const stepId = job.payload.step_id;
  if (typeof stepId !== "string") return { ok: false, error: "The job has no step_id." };

  const ctx = await store.loadStep(stepId);
  if (!ctx) return { ok: false, error: "The step does not exist." };
  if (!(await store.startStep(stepId))) return { ok: true, result: { skipped: true } };

  const { school, rollout } = ctx;
  const tag = rollout.image_tag;
  const from = school.image_tag;
  let applied: string[] = [];
  let schemaVersion: string | null = null;
  let deployed = false;

  try {
    if (school.status !== "active")
      throw new StepFailure(`The school is ${school.status}, not active.`);
    const host = school.hostnames[0];
    if (!host) throw new StepFailure("The school has no hostname.");

    // 1. migrate
    const url = await secrets.schoolDatabaseUrl(school.slug);
    const conn = await deps.connect(url);
    try {
      await store.reconcileRuns(school.id, await readAppliedVersions(conn.db));
      const [registered, seqs] = await Promise.all([
        store.registeredMigrations(),
        store.releaseSeqs(),
      ]);
      const out = await applyPendingMigrations({
        db: conn.db,
        registered,
        targetSeq: rollout.release_seq,
        currentTag: school.image_tag,
        appSeq: (t) => (t ? (seqs.get(t) ?? null) : null),
        recorder: {
          start: (m) => store.startRun(school.id, stepId, m.id),
          finish: (runId, ok, error) => store.finishRun(runId, ok, error),
        },
        log,
      });
      applied = out.applied;
      schemaVersion = out.latestVersion;
    } catch (error) {
      if (error instanceof MigrationError) {
        applied = error.applied;
        // Earlier migrations in this run stay applied, so record the school's
        // real version now rather than leaving it stale until the next scan.
        if (error.latestVersion) {
          await store
            .updateSchool(school.id, { schema_version: error.latestVersion })
            .catch(() => {});
        }
      }
      throw error;
    } finally {
      await conn.close().catch(() => {});
    }
    await store.updateSchool(school.id, {
      schema_version: schemaVersion,
      credentials_status: "ok",
    });

    // 2. deploy (the script waits for health and rolls itself back if it fails)
    if (from !== tag) {
      const out = await deps.deploy({ action: "deploy", slug: school.slug, tag });
      if (!out.ok) throw new StepFailure(`Deploy failed: ${out.message}`, { applied });
      deployed = true;
    }

    // 3. verify with the deeper probe; undo the deploy if it disagrees
    const probe = await deps.probe(host, school.slug);
    if (!probe.ok || probe.version !== tag) {
      const why = probe.ok
        ? `it reports version ${probe.version?.slice(0, 12) ?? "unknown"}, not ${tag.slice(0, 12)}`
        : (probe.error ?? "unhealthy");
      let undo = "";
      if (deployed) {
        const rb = await deps.deploy({ action: "rollback", slug: school.slug }).catch(() => null);
        undo = rb?.ok ? " The deploy was rolled back." : " The rollback FAILED: check the server.";
      }
      throw new StepFailure(`Health check failed after deploy: ${why}.${undo}`, { applied });
    }

    await store.updateSchool(school.id, { image_tag: tag, app_version: tag });
    const result = {
      applied,
      from_tag: from,
      to_tag: tag,
      schema_version: schemaVersion,
      deployed,
    };
    await store.completeStep(stepId, true, result, null);
    return { ok: true, result };
  } catch (error) {
    const message = clip(secrets.redact(error instanceof Error ? error.message : String(error)));
    const partial = error instanceof StepFailure ? error.partial : { applied };
    const result = { applied, from_tag: from, to_tag: tag, ...partial };
    await store.completeStep(stepId, false, result, message);
    return { ok: false, result, error: message };
  }
}

// Reads which migrations a school has, so the dashboard can show the version
// matrix and spot drift. Read-only on the school's database.
export async function handleSchemaScan(job: Job, deps: HandlerDeps): Promise<HandlerResult> {
  const { store, secrets } = deps;
  if (!job.school_id) return { ok: false, error: "The scan has no school." };
  const school = await store.schoolForScan(job.school_id);
  if (!school) return { ok: false, error: "The school does not exist." };

  let conn: Awaited<ReturnType<HandlerDeps["connect"]>> | null = null;
  try {
    conn = await deps.connect(await secrets.schoolDatabaseUrl(school.slug));
    const versions = await readAppliedVersionsReadOnly(conn.db);
    await store.reconcileRuns(school.id, versions);
    const latest = [...versions].sort().at(-1) ?? null;
    await store.updateSchool(school.id, { schema_version: latest, credentials_status: "ok" });
    return { ok: true, result: { latest, count: versions.length } };
  } catch (error) {
    const status = classifyConnectError(error);
    if (status) await store.updateSchool(school.id, { credentials_status: status }).catch(() => {});
    return {
      ok: false,
      error: clip(secrets.redact(error instanceof Error ? error.message : String(error))),
    };
  } finally {
    await conn?.close().catch(() => {});
  }
}
