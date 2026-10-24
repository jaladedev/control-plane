import {
  MigrationError,
  applyPendingMigrations,
  planMigrations,
  readAppliedVersions,
  readAppliedVersionsReadOnly,
  type PgLike,
} from "@/lib/migrate/runner";
import type { DeployCommand, DeployOutcome } from "@/lib/deploy/client";
import type { ProbeResult } from "@/lib/health";
import type { Job, SchoolPatch, Store } from "@/worker/store";
import type { SecretsProvider } from "@/worker/secrets";
import { decideBackup, type BackupProvider } from "@/worker/backup";

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
  /** Backs up a school's database before its migrations run. */
  backup: BackupProvider;
  /** How many finished backups to keep per school; older ones are pruned. */
  backupKeep: number;
  log: (message: string) => void;
};

// What the step's result says about the backup: taken (and where), skipped (and
// why), or failed (and why). Recorded whatever happens afterwards.
export type BackupInfo =
  | { status: "taken"; id: string; objectKey: string; sizeBytes: number; sha256: string }
  | { status: "skipped"; reason: string }
  | { status: "failed"; id?: string; error: string };

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

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

// Takes the backup, records it, and tidies old ones. Throws a StepFailure when
// the backup cannot be made or cannot be recorded: nothing has been migrated
// yet, so the step fails with the school's database untouched.
async function takeBackup(
  deps: HandlerDeps,
  school: { id: string; slug: string },
  stepId: string,
  databaseUrl: string
): Promise<Extract<BackupInfo, { status: "taken" }>> {
  const { store, secrets, log } = deps;
  const id = await store.startBackup(school.id, stepId);
  let artifact;
  try {
    log(`backing up ${school.slug}`);
    artifact = await deps.backup.create({ slug: school.slug, backupId: id, databaseUrl });
  } catch (error) {
    const text = clip(secrets.redact(errorText(error)));
    await store.finishBackup(id, { ok: false, error: text }).catch(() => {});
    throw new StepFailure(`The backup failed, so no migration was run: ${text}`, {
      backup: { status: "failed", id, error: text } satisfies BackupInfo,
    });
  }
  try {
    await store.finishBackup(id, { ok: true, ...artifact });
  } catch (error) {
    // The object exists but is not on record. Say where it is, so it is not lost.
    const text = clip(secrets.redact(errorText(error)));
    throw new StepFailure(
      `A backup was uploaded (${artifact.objectKey}) but could not be recorded, so no migration was run: ${text}`,
      { backup: { status: "failed", id, error: text } satisfies BackupInfo }
    );
  }
  log(`backed up ${school.slug}: ${artifact.objectKey} (${artifact.sizeBytes} bytes)`);

  // Retention is housekeeping: it can never fail the step.
  try {
    for (const old of await store.backupsToPrune(school.id, deps.backupKeep)) {
      await deps.backup.remove(old.object_key);
      await store.markBackupPruned(old.id);
      log(`pruned ${old.object_key}`);
    }
  } catch (error) {
    log(`could not prune old backups of ${school.slug}: ${secrets.redact(errorText(error))}`);
  }
  return { status: "taken", id, ...artifact };
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
  let backup: BackupInfo | null = null;

  try {
    if (school.status !== "active")
      throw new StepFailure(`The school is ${school.status}, not active.`);
    const host = school.hostnames[0];
    if (!host) throw new StepFailure("The school has no hostname.");

    // 1. migrate
    const url = await secrets.schoolDatabaseUrl(school.slug);
    const conn = await deps.connect(url);
    try {
      const appliedNow = await readAppliedVersions(conn.db);
      await store.reconcileRuns(school.id, appliedNow);
      const [registered, seqs] = await Promise.all([
        store.registeredMigrations(),
        store.releaseSeqs(),
      ]);
      const plan = {
        registered,
        targetSeq: rollout.release_seq,
        currentTag: school.image_tag,
        appSeq: (t: string | null) => (t ? (seqs.get(t) ?? null) : null),
      };

      // Every refusal the runner would make is made here first, so a school
      // that is going to be refused is not backed up for nothing.
      const { pending } = planMigrations(plan, appliedNow);
      const decision = decideBackup(rollout.backup_policy, pending);
      if (decision.take) {
        backup = await takeBackup(deps, school, stepId, url);
      } else {
        backup = { status: "skipped", reason: decision.reason };
        log(`no backup for ${school.slug}: ${decision.reason}`);
      }

      const out = await applyPendingMigrations({
        db: conn.db,
        ...plan,
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
      backup,
    };
    await store.completeStep(stepId, true, result, null);
    return { ok: true, result };
  } catch (error) {
    const message = clip(secrets.redact(error instanceof Error ? error.message : String(error)));
    const partial = error instanceof StepFailure ? error.partial : { applied };
    const result = { applied, from_tag: from, to_tag: tag, backup, ...partial };
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
