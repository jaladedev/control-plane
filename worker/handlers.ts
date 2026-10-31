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
import { planRegistration } from "@/lib/migrate/register";
import { claimNotice } from "@/lib/billing/telegram";
import type { Job, SchoolPatch, Store } from "@/worker/store";
import type { SecretsProvider } from "@/worker/secrets";
import { decideBackup, type BackupProvider } from "@/worker/backup";
import type { StorageCheck } from "@/worker/storage-check";
import type { AuthAdmin } from "@/worker/auth-admin";

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
  /** Reads a commit's migration files from GitHub. Absent when the worker has no GITHUB_TOKEN. */
  fetchMigrations?: (tag: string) => Promise<{ name: string; content: string }[]>;
  /** Checks a school's R2 bucket and key. Absent in tests that do not provision. */
  checkStorage?: StorageCheck;
  /** Creates the first admin in a school's Auth. Absent in tests that do not provision. */
  authAdmin?: AuthAdmin;
  /** Waits; replaced in tests so the health step does not really wait. */
  sleep?: (ms: number) => Promise<void>;
  /** How often provisioning probes the school's public address before giving up. */
  healthAttempts?: number;
  /** Sends a Telegram message. Absent when the worker has no bot configured. */
  telegram?: { send: (text: string) => Promise<void>; appUrl?: string | null };
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

const TAG = /^[0-9a-f]{40}$/;
const short = (tag: string | null | undefined) => (tag ? tag.slice(0, 12) : "unknown");

// Takes one school back to the image it ran before. Unlike a deploy this is NOT
// idempotent (the server swaps current and previous, so doing it twice puts the
// school forward again), which is why the job has a single attempt, and why the
// server must first agree about what is running: never act on a guess.
export async function handleSchoolRollback(job: Job, deps: HandlerDeps): Promise<HandlerResult> {
  const { store, secrets } = deps;
  if (!job.school_id) return { ok: false, error: "The job has no school." };
  const school = await store.schoolForAction(job.school_id);
  if (!school) return { ok: false, error: "That school does not exist." };
  const host = school.hostnames[0];
  if (!host) return { ok: false, error: `${school.slug} has no hostname.` };
  const from = school.image_tag;

  try {
    const state = await deps.deploy({ action: "status", slug: school.slug });
    if (!state.ok) throw new StepFailure(`Could not read the server's state: ${state.message}`);
    if (!from || state.tag !== from) {
      throw new StepFailure(
        `The server says ${short(state.tag)} is running but the dashboard says ${short(from)}. ` +
          "Nothing was changed. Refresh versions, check the server, then try again."
      );
    }

    const out = await deps.deploy({ action: "rollback", slug: school.slug });
    if (!out.ok) throw new StepFailure(`Rollback failed: ${out.message}`);
    if (!TAG.test(out.tag)) {
      throw new StepFailure(
        "The server did not say which version it went back to. Check it directly."
      );
    }
    // The server confirmed this image is healthy, so record it before anything else.
    await store.updateSchool(school.id, { image_tag: out.tag, app_version: out.tag });

    const probe = await deps.probe(host, school.slug);
    if (!probe.ok || probe.version !== out.tag) {
      const why = probe.ok
        ? `it reports version ${short(probe.version)}`
        : (probe.error ?? "unhealthy");
      throw new StepFailure(
        `Rolled back to ${short(out.tag)}, but the school does not look right: ${why}. Check the server.`,
        { to_tag: out.tag }
      );
    }
    return { ok: true, result: { from_tag: from, to_tag: out.tag } };
  } catch (error) {
    const message = clip(secrets.redact(error instanceof Error ? error.message : String(error)));
    const partial = error instanceof StepFailure ? error.partial : {};
    return { ok: false, result: { from_tag: from, ...partial }, error: message };
  }
}

// Registers a release from a commit's migrations on GitHub: the same rules as
// the register-release CLI (planRegistration), with one difference. There is
// no --baseline here: the first registration, which needs one, stays a CLI step.
export async function handleRegisterRelease(job: Job, deps: HandlerDeps): Promise<HandlerResult> {
  const { store } = deps;
  const tag = String(job.payload.tag ?? "");
  if (!TAG.test(tag))
    return { ok: false, error: "The release must be a full 40-character commit hash." };
  if (!deps.fetchMigrations) {
    return {
      ok: false,
      error:
        "The worker has no GITHUB_TOKEN, so it cannot read the school app's migrations. " +
        "Set it, or register with npm run register-release.",
    };
  }

  const files = await deps.fetchMigrations(tag); // a network error propagates: the job is retried
  if (files.length === 0) return { ok: false, error: `No .sql files found at ${short(tag)}.` };

  const registered = await store.registryRows();
  const plan = planRegistration(files, registered);
  if (plan.errors.length > 0) {
    const first =
      registered.length === 0
        ? " The first registration needs --baseline: use npm run register-release."
        : "";
    return {
      ok: false,
      error: clip(`Cannot register ${short(tag)}: ${plan.errors.join(" ")}${first}`),
    };
  }

  const notes = typeof job.payload.notes === "string" ? job.payload.notes : null;
  const by = typeof job.payload.by === "string" ? job.payload.by : "dashboard";
  try {
    await store.registerRelease({
      tag,
      notes,
      by,
      migrations: plan.newMigrations.map((m) => ({
        version: m.version,
        name: m.name,
        checksum: m.checksum,
        kind: m.kind,
        min_app_version: m.minAppVersion ?? "",
        sql: m.sql,
      })),
    });
  } catch (error) {
    // A retry after a registration that landed but was not reported.
    if (/already registered/i.test(error instanceof Error ? error.message : "")) {
      return { ok: true, result: { already_registered: true, migrations: [] } };
    }
    throw error;
  }
  return { ok: true, result: { migrations: plan.newMigrations.map((m) => m.name) } };
}

// Pushes a school's licence (as saved on its registry row) into the school's own
// database with set_license(), over the worker's direct connection, so the web app
// never needs a service key for it. Safe to repeat: the school ignores a version it
// already has, and a push that has already landed is skipped here. A failure is
// recorded on the registry row and thrown, so the job is retried; the owner sees it.
export async function handleLicensePush(job: Job, deps: HandlerDeps): Promise<HandlerResult> {
  const { store, secrets } = deps;
  if (!job.school_id) return { ok: false, error: "The job has no school." };
  const lic = await store.licenseForPush(job.school_id);
  if (!lic) return { ok: false, error: "That school does not exist." };
  if (!lic.license_session || !lic.license_valid_until || !lic.license_grace_until) {
    return { ok: false, error: `${lic.slug} has no licence saved to push.` };
  }
  if (lic.license_pushed_version >= lic.license_version) {
    return { ok: true, result: { skipped: "already pushed", version: lic.license_version } };
  }

  let message = "";
  try {
    const conn = await deps.connect(await secrets.schoolDatabaseUrl(lic.slug));
    try {
      const res = await conn.db.query(
        "select set_license($1::uuid, $2::bigint, $3::text, $4::timestamptz, $5::timestamptz, $6::integer, $7::text[], $8::boolean) as applied",
        [
          lic.id,
          lic.license_version,
          lic.license_session,
          lic.license_valid_until,
          lic.license_grace_until,
          lic.included_students > 0 ? lic.included_students : null,
          lic.features,
          lic.license_is_trial,
        ]
      );
      // false: the school already has this version or a newer one. Either way it is in step.
      const applied = res.rows[0]?.applied === true;
      await store.recordLicensePush(lic.id, lic.license_version, true, null);
      return { ok: true, result: { version: lic.license_version, applied } };
    } finally {
      await conn.close().catch(() => {});
    }
  } catch (error) {
    message = clip(secrets.redact(error instanceof Error ? error.message : String(error)));
  }
  await store.recordLicensePush(lic.id, lic.license_version, false, message).catch(() => {});
  throw new Error(`Licence push for ${lic.slug} failed: ${message}`);
}

// Tells you on Telegram that a claim needs checking, once, and once more if it is
// still waiting after 48 hours. Never blocks the claim: a failed send is retried
// and, if it keeps failing, shows as a failed job while the claim stays in the queue.
export async function handleTelegramNotify(job: Job, deps: HandlerDeps): Promise<HandlerResult> {
  const { store } = deps;
  const kind = job.payload.kind === "reminder" ? "reminder" : "claim";
  const claimId = String(job.payload.claim_id ?? "");
  if (!deps.telegram) {
    return {
      ok: false,
      error: "Telegram is not set up on the worker (TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID).",
    };
  }
  // A card payment that could not be applied. The database wrote the message, so there
  // is nothing to look up; it goes out as it is.
  if (job.payload.kind === "paystack_review") {
    const message =
      typeof job.payload.message === "string" ? job.payload.message.slice(0, 1000) : "";
    if (!message) return { ok: false, error: "The review notice has no message." };
    await deps.telegram.send(message);
    return { ok: true, result: { sent: "paystack_review" } };
  }
  const claim = await store.claimForNotice(claimId);
  if (!claim) return { ok: false, error: "That claim does not exist." };
  if (claim.status !== "pending")
    return { ok: true, result: { skipped: `already ${claim.status}` } };
  if ((kind === "claim" ? claim.notified_at : claim.reminded_at) !== null) {
    return { ok: true, result: { skipped: "already sent" } };
  }
  const ageHours = (Date.now() - Date.parse(claim.created_at)) / 3_600_000;
  await deps.telegram.send(
    claimNotice({
      kind,
      schoolName: claim.school_name,
      amountKobo: claim.amount_kobo,
      reference: claim.reference,
      session: claim.session,
      sentOn: claim.sent_on,
      ageHours,
      appUrl: deps.telegram.appUrl,
    })
  );
  await store.markClaimNotified(claim.id, kind);
  return { ok: true, result: { sent: kind } };
}
