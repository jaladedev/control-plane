import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireActor } from "@/lib/auth/guards";
import { withAudit } from "@/lib/audit";

// Rollout controls. Owner only (plan section 6). The dashboard never runs a
// migration or a deploy: these only record the owner's decision and queue it;
// the worker does the work. Each action writes its audit row first. The
// canary order and the stop-on-first-failure rule are enforced in the database
// (release_rollout, complete_step), so they hold whatever calls them.

export const RELEASE_TARGETS = ["test", "pilot", "next_batch", "all"] as const;
export type ReleaseTarget = (typeof RELEASE_TARGETS)[number];

type Admin = ReturnType<typeof createAdminClient>;

// The database's refusals are written for people ("Every test school must
// succeed before the pilot."), so they are passed through as they are.
async function rpc(admin: Admin, fn: string, args: Record<string, unknown>) {
  const { data, error } = await admin.rpc(fn, args);
  if (error) throw new Error(error.message);
  return data;
}

export const BACKUP_POLICIES = ["required", "skip_if_expand_only"] as const;
export type BackupPolicy = (typeof BACKUP_POLICIES)[number];

export async function createRollout(
  releaseId: string,
  batchSize: unknown,
  backupPolicy: unknown = "required"
): Promise<{ id: string }> {
  const actor = await requireActor(["owner"]);
  const release = z.string().uuid().parse(releaseId);
  const size = z.coerce
    .number()
    .int()
    .min(1, "Batch size must be at least 1.")
    .max(50, "Batch size is at most 50.")
    .parse(batchSize);
  // Anything but the one explicit skip option means "back up first".
  const policy: BackupPolicy = backupPolicy === "skip_if_expand_only" ? backupPolicy : "required";

  const admin = createAdminClient();
  const { data: row, error } = await admin
    .from("releases")
    .select("image_tag")
    .eq("id", release)
    .maybeSingle();
  if (error || !row) throw new Error("That release does not exist.");

  return withAudit(
    actor,
    {
      action: "rollout.create",
      details: {
        release_id: release,
        image_tag: row.image_tag,
        batch_size: size,
        backup_policy: policy,
      },
    },
    async () => ({
      id: (await rpc(admin, "create_rollout", {
        p_release: release,
        p_batch_size: size,
        p_by: actor.email,
        p_backup_policy: policy,
      })) as string,
    })
  );
}

/**
 * Lets more of a rollout run. Releasing a batch or everything also needs the
 * word ALL typed, because it changes many schools' databases and apps.
 */
export async function releaseRollout(
  rolloutId: string,
  target: string,
  confirm?: unknown
): Promise<void> {
  const actor = await requireActor(["owner"]);
  const id = z.string().uuid().parse(rolloutId);
  const to = z.enum(RELEASE_TARGETS).parse(target);
  if ((to === "next_batch" || to === "all") && confirm !== "ALL") {
    throw new Error("Type ALL (capitals) to release more than the test and pilot schools.");
  }
  const admin = createAdminClient();
  await withAudit(
    actor,
    { action: "rollout.release", details: { rollout_id: id, target: to } },
    async () => {
      await rpc(admin, "release_rollout", { p_rollout: id, p_target: to });
    }
  );
}

export async function retryStep(stepId: string): Promise<void> {
  const actor = await requireActor(["owner"]);
  const id = z.string().uuid().parse(stepId);
  const admin = createAdminClient();
  const { data: step, error } = await admin
    .from("rollout_steps")
    .select("rollout_id, school_id, schools(slug)")
    .eq("id", id)
    .maybeSingle();
  if (error || !step) throw new Error("That step does not exist.");
  const slug = (step as unknown as { schools: { slug: string } | null }).schools?.slug ?? null;

  await withAudit(
    actor,
    {
      action: "rollout.retry_step",
      schoolId: step.school_id,
      details: { step_id: id, rollout_id: step.rollout_id, slug },
    },
    async () => {
      await rpc(admin, "retry_step", { p_step: id });
    }
  );
}

export async function cancelRollout(rolloutId: string, confirm?: unknown): Promise<void> {
  const actor = await requireActor(["owner"]);
  const id = z.string().uuid().parse(rolloutId);
  if (confirm !== "yes") throw new Error("Tick the box to confirm cancelling the rollout.");
  const admin = createAdminClient();
  await withAudit(actor, { action: "rollout.cancel", details: { rollout_id: id } }, async () => {
    await rpc(admin, "cancel_rollout", { p_rollout: id });
  });
}

/** Asks the worker to re-read which migrations a school (or every school) has. */
export async function requestSchemaScan(schoolId?: string | null): Promise<{ queued: number }> {
  const actor = await requireActor(["owner"]);
  const id = schoolId ? z.string().uuid().parse(schoolId) : null;
  const admin = createAdminClient();
  return withAudit(
    actor,
    { action: "schema.scan_request", schoolId: id, details: { all: id === null } },
    async () => ({
      queued: Number(await rpc(admin, "enqueue_schema_scan", { p_school: id })) || 0,
    })
  );
}

// ---------------------------------------------------------------------------
// One school, rolling a school back, registering a release
// ---------------------------------------------------------------------------

async function schoolSlug(admin: Admin, id: string): Promise<string> {
  const { data, error } = await admin.from("schools").select("slug").eq("id", id).maybeSingle();
  if (error || !data) throw new Error("That school does not exist.");
  return data.slug as string;
}

function needSlug(confirm: unknown, slug: string) {
  if (typeof confirm !== "string" || confirm.trim() !== slug) {
    throw new Error(`To confirm, type the school's name (${slug}) exactly.`);
  }
}

/**
 * A rollout of one school: for an urgent fix, or to upgrade a single school.
 * No canary stages, so the owner types the school's name instead. It starts at
 * once; halting on failure, retry and cancel work as for a full rollout.
 */
export async function createSchoolRollout(
  releaseId: string,
  schoolId: string,
  confirm: unknown
): Promise<{ id: string }> {
  const actor = await requireActor(["owner"]);
  const release = z.string().uuid().parse(releaseId);
  const school = z.string().uuid().parse(schoolId);
  const admin = createAdminClient();

  const slug = await schoolSlug(admin, school);
  needSlug(confirm, slug);
  const { data: row } = await admin
    .from("releases")
    .select("image_tag")
    .eq("id", release)
    .maybeSingle();
  if (!row) throw new Error("That release does not exist.");

  return withAudit(
    actor,
    {
      action: "rollout.create_school",
      schoolId: school,
      details: { release_id: release, image_tag: row.image_tag, slug },
    },
    async () => ({
      id: (await rpc(admin, "create_school_rollout", {
        p_release: release,
        p_school: school,
        p_by: actor.email,
      })) as string,
    })
  );
}

/**
 * Takes one school back to the image it ran before. Migrations are not undone
 * (expand migrations are safe for the old app by design). The worker checks the
 * server agrees about what is running first, and tries exactly once.
 */
export async function rollbackSchool(
  schoolId: string,
  confirm: unknown
): Promise<{ jobId: string }> {
  const actor = await requireActor(["owner"]);
  const school = z.string().uuid().parse(schoolId);
  const admin = createAdminClient();

  const slug = await schoolSlug(admin, school);
  needSlug(confirm, slug);

  return withAudit(
    actor,
    { action: "school.rollback", schoolId: school, details: { slug } },
    async () => ({
      jobId: (await rpc(admin, "queue_school_rollback", {
        p_school: school,
        p_by: actor.email,
      })) as string,
    })
  );
}

/**
 * Applies the school's container settings (SCHOOL_APP_ENVS on the worker) to its
 * running container: rotated keys, a new setting. The dashboard holds none of
 * those values; it only queues the job. The owner types the school's name because
 * the school restarts. One attempt (the server puts the old settings back itself
 * if the school is unhealthy on the new ones).
 */
export async function applySchoolSettings(
  schoolId: string,
  confirm: unknown
): Promise<{ jobId: string }> {
  const actor = await requireActor(["owner"]);
  const school = z.string().uuid().parse(schoolId);
  const admin = createAdminClient();

  const slug = await schoolSlug(admin, school);
  needSlug(confirm, slug);

  return withAudit(
    actor,
    { action: "school.apply_settings", schoolId: school, details: { slug } },
    async () => ({
      jobId: (await rpc(admin, "queue_reconfigure", {
        p_school: school,
        p_by: actor.email,
      })) as string,
    })
  );
}

/**
 * Asks the worker to read a commit's migrations from GitHub and register the
 * release. The very first registration (which needs --baseline) is still done
 * with the register-release command.
 */
export async function registerRelease(tag: unknown, notes?: unknown): Promise<{ jobId: string }> {
  const actor = await requireActor(["owner"]);
  const commit = z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[0-9a-f]{40}$/, "A release is a full 40-character commit hash.")
    .parse(tag);
  const note = z
    .preprocess(
      (v) => (v === "" || v === null ? undefined : v),
      z.string().trim().max(500, "Notes are at most 500 characters.").optional()
    )
    .parse(notes);

  const admin = createAdminClient();
  return withAudit(
    actor,
    { action: "release.register", details: { tag: commit, via: "dashboard", notes: note ?? null } },
    async () => ({
      jobId: (await rpc(admin, "queue_register_release", {
        p_tag: commit,
        p_notes: note ?? null,
        p_by: actor.email,
      })) as string,
    })
  );
}
