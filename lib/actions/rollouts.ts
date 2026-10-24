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

export async function createRollout(
  releaseId: string,
  batchSize: unknown
): Promise<{ id: string }> {
  const actor = await requireActor(["owner"]);
  const release = z.string().uuid().parse(releaseId);
  const size = z.coerce
    .number()
    .int()
    .min(1, "Batch size must be at least 1.")
    .max(50, "Batch size is at most 50.")
    .parse(batchSize);

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
      details: { release_id: release, image_tag: row.image_tag, batch_size: size },
    },
    async () => ({
      id: (await rpc(admin, "create_rollout", {
        p_release: release,
        p_batch_size: size,
        p_by: actor.email,
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
