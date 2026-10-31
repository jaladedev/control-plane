import {
  MigrationError,
  applyPendingMigrations,
  readAppliedVersions,
  type PgLike,
} from "@/lib/migrate/runner";
import { buildSchoolEnvFile } from "@/lib/provision/env";
import {
  classifyConnectError,
  handleLicensePush,
  type HandlerDeps,
  type HandlerResult,
} from "@/worker/handlers";
import { PROVISION_STEPS, type ProvisionStep } from "@/lib/provision/steps";
import type { Job } from "@/worker/store";

// Brings a registered school live: its database, its storage, its container
// and domain, its licence, a health check, and then the flip to "active". Each
// step is recorded as it runs, and a step that already succeeded is never run
// again, so pressing Resume after a failure carries on where it stopped.
//
// Expected failures (a wrong password, DNS not pointed yet) are reported on the
// step and end the job, because the owner has to change something first. Errors
// thrown for anything unexpected propagate so the worker retries the job.

class StepFailure extends Error {}

const clip = (s: string, n = 800) => (s.length > n ? `${s.slice(0, n)}…` : s);
const short = (tag: string) => tag.slice(0, 12);
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function handleProvisionSchool(job: Job, deps: HandlerDeps): Promise<HandlerResult> {
  const { store, secrets, log } = deps;
  if (!job.school_id) return { ok: false, error: "The job has no school." };
  const ctx = await store.provisionContext(job.school_id);
  if (!ctx) return { ok: false, error: "That school does not exist." };
  const { school, release, steps } = ctx;

  if (school.status !== "provisioning") {
    // A retried job whose last step had already landed.
    if (school.status === "active" && steps.activate === "succeeded") {
      return { ok: true, result: { skipped: "already active" } };
    }
    return { ok: false, error: `${school.slug} is ${school.status}, not being provisioned.` };
  }
  if (!release)
    return { ok: false, error: "No release is registered, so there is nothing to deploy." };
  const host = school.hostnames[0];
  if (!host) return { ok: false, error: `${school.slug} has no hostname.` };

  const tag = release.image_tag;
  const by = typeof job.payload.by === "string" ? job.payload.by : "dashboard";

  // The container's settings are checked before anything is changed, and again
  // wherever they are used, so a mistake never gets as far as a database.
  const settings = async () => {
    const built = buildSchoolEnvFile(await secrets.schoolAppEnv(school.slug), {
      slug: school.slug,
      supabaseProjectRef: school.supabase_project_ref,
      r2Bucket: school.r2_bucket,
    });
    if (!built.ok) {
      throw new StepFailure(`The school's settings are not ready: ${built.errors.join(" ")}`);
    }
    return built.file;
  };

  const impl: Record<ProvisionStep, () => Promise<string>> = {
    // 1. The school's own database: every migration of the latest release.
    async database() {
      await settings();
      let url: string;
      try {
        url = await secrets.schoolDatabaseUrl(school.slug);
      } catch (error) {
        throw new StepFailure(errorText(error));
      }
      let conn: Awaited<ReturnType<HandlerDeps["connect"]>>;
      try {
        conn = await deps.connect(url);
      } catch (error) {
        const status = classifyConnectError(error);
        if (status) {
          await store.updateSchool(school.id, { credentials_status: status }).catch(() => {});
        }
        throw new StepFailure(`Could not connect to the school's database: ${errorText(error)}`);
      }
      try {
        const applied = await readAppliedVersions(conn.db);
        if (applied.length === 0 && (await hasTables(conn.db))) {
          throw new StepFailure(
            "The database already has tables but no migration history, so this looks like an " +
              "existing school. Use npm run adopt-school for it; provisioning would collide with its schema."
          );
        }
        const [registered, seqs] = await Promise.all([
          store.registeredMigrations(),
          store.releaseSeqs(),
        ]);
        try {
          const out = await applyPendingMigrations({
            db: conn.db,
            registered,
            targetSeq: release.seq,
            // A new school starts on the release being deployed, so a contract
            // migration's "app is new enough" rule is met by that release.
            currentTag: tag,
            appSeq: (t) => (t ? (seqs.get(t) ?? null) : null),
            recorder: {
              start: (m) => store.startRun(school.id, null, m.id),
              finish: (runId, ok, error) => store.finishRun(runId, ok, error),
            },
            log,
          });
          await store.updateSchool(school.id, {
            schema_version: out.latestVersion,
            credentials_status: "ok",
          });
          return `${out.applied.length} migration(s) applied, ${out.alreadyApplied} already there`;
        } catch (error) {
          if (error instanceof MigrationError) {
            if (error.latestVersion) {
              await store
                .updateSchool(school.id, { schema_version: error.latestVersion })
                .catch(() => {});
            }
            throw new StepFailure(error.message);
          }
          throw error;
        }
      } finally {
        await conn.close().catch(() => {});
      }
    },

    // 2. The school's R2 bucket, with the key its container will use.
    async storage() {
      await settings();
      const env = (await secrets.schoolAppEnv(school.slug)) ?? {};
      if (!deps.checkStorage) throw new StepFailure("The worker has no storage check configured.");
      const res = await deps.checkStorage({
        endpoint: env.R2_ENDPOINT,
        bucket: env.R2_BUCKET,
        accessKeyId: env.R2_ACCESS_KEY_ID,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      });
      if (!res.ok) throw new StepFailure(res.error);
      return `bucket ${env.R2_BUCKET} can be read and written`;
    },

    // 3. Env file, container, proxy route and domain: one command on the server.
    async container() {
      const file = await settings();
      const state = await deps.deploy({ action: "status", slug: school.slug });
      if (!state.ok) throw new StepFailure(`Could not read the server's state: ${state.message}`);
      if (state.tag) {
        if (state.tag === tag && state.status === "running") {
          return `already running at ${short(tag)}`;
        }
        throw new StepFailure(
          `The server already has ${school.slug} (${short(state.tag)}, ${state.status}). ` +
            "Nothing was changed. Look at the server, or remove it there, then resume."
        );
      }
      const out = await deps.deploy({
        action: "create",
        slug: school.slug,
        tag,
        hostnames: school.hostnames,
        env: file,
      });
      if (!out.ok) {
        let extra = "";
        if (out.code === 13) {
          // The container runs without a route; remove it so the next try starts clean.
          const removed = await deps
            .deploy({ action: "remove", slug: school.slug })
            .catch(() => null);
          extra = removed?.ok
            ? " The half-made school was removed, so Resume starts clean."
            : " It could NOT be removed: check the server.";
        }
        throw new StepFailure(`Create failed: ${out.message}${extra}`);
      }
      return `container started at ${short(tag)} for ${school.hostnames.join(", ")}`;
    },

    // 4. The trial licence the owner saved, delivered with set_license().
    async license() {
      let out: HandlerResult;
      try {
        out = await handleLicensePush({ ...job, type: "license_push" }, deps);
      } catch (error) {
        throw new StepFailure(errorText(error));
      }
      if (!out.ok) throw new StepFailure(out.error ?? "The licence could not be delivered.");
      return "licence delivered";
    },

    // 5. The school answers on its public address, on this release. DNS and the
    //    proxy's certificate can take a few minutes, so this tries for a while.
    async health() {
      const attempts = deps.healthAttempts ?? 8;
      const sleep = deps.sleep ?? defaultSleep;
      let why = "no answer";
      for (let i = 0; i < attempts; i++) {
        const probe = await deps.probe(host, school.slug);
        if (probe.ok && probe.version === tag) return `healthy on https://${host}`;
        why = probe.ok
          ? `it reports version ${probe.version ? short(probe.version) : "unknown"}, not ${short(tag)}`
          : (probe.error ?? "unhealthy");
        if (i < attempts - 1) await sleep(15_000);
      }
      throw new StepFailure(
        `https://${host} did not answer healthy: ${why}. Check that its DNS record points at ` +
          "the server, then resume."
      );
    },

    // 6. Live: the registry row flips to active, with an audit row of its own.
    async activate() {
      const changed = await store.activateSchool(school.id, tag, null, by);
      return changed ? "school is active" : "school was already active";
    },
  };

  const completed: string[] = [];
  for (const step of PROVISION_STEPS) {
    if (steps[step] === "succeeded") {
      completed.push(step);
      continue;
    }
    await store.recordProvisionStep(school.id, step, "running", null);
    log(`provisioning ${school.slug}: ${step}`);
    let detail: string;
    try {
      detail = await impl[step]();
    } catch (error) {
      if (!(error instanceof StepFailure)) throw error;
      const message = clip(secrets.redact(error.message));
      await store.recordProvisionStep(school.id, step, "failed", message);
      await notify(deps, `Provisioning ${school.slug} stopped at "${step}": ${message}`);
      return {
        ok: false,
        result: { failed_step: step, completed },
        error: `${step}: ${message}`,
      };
    }
    await store.recordProvisionStep(
      school.id,
      step,
      "succeeded",
      clip(secrets.redact(detail), 300)
    );
    completed.push(step);
  }

  await notify(deps, `${school.slug} is live at https://${host}`);
  return { ok: true, result: { tag, completed } };
}

async function hasTables(db: PgLike): Promise<boolean> {
  const { rows } = await db.query(
    "select count(*)::int as n from information_schema.tables where table_schema = 'public'"
  );
  return Number(rows[0]?.n ?? 0) > 0;
}

// A notice that cannot be sent never changes the outcome.
async function notify(deps: HandlerDeps, text: string) {
  try {
    await deps.telegram?.send(text);
  } catch (error) {
    deps.log(`notice failed: ${errorText(error)}`);
  }
}
