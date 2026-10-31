import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireActor } from "@/lib/auth/guards";
import { withAudit } from "@/lib/audit";

// Records the outcome of a restore drill (plan M6): someone restored a backup into
// a scratch database with scripts/restore-drill.sh and looked at the result. The
// restore needs the offline age key, which never reaches this app, so the dashboard
// can only be told. Owner only; audited; the record cannot be edited afterwards.

const uuidOrBlank = z.preprocess(
  (v) => (v === "" || v === null || v === undefined ? null : v),
  z.string().uuid().nullable()
);

const drillSchema = z.object({
  // Blank school means the control plane's own backup.
  schoolId: uuidOrBlank,
  backupId: uuidOrBlank,
  ok: z.preprocess((v) => v === true || v === "true" || v === "yes", z.boolean()),
  minutes: z.coerce
    .number()
    .min(0, "Minutes cannot be negative.")
    .max(1440, "Minutes is at most 1440 (a day)."),
  notes: z.preprocess(
    (v) => (v === "" || v === null || v === undefined ? null : v),
    z.string().trim().max(1000, "Notes are at most 1000 characters.").nullable()
  ),
});

export async function recordRestoreDrill(input: Record<string, unknown>): Promise<{ id: string }> {
  const actor = await requireActor(["owner"]);
  const d = drillSchema.parse(input);
  const seconds = Math.round(d.minutes * 60);

  const admin = createAdminClient();
  let slug: string | null = null;
  if (d.schoolId) {
    const { data, error } = await admin
      .from("schools")
      .select("slug")
      .eq("id", d.schoolId)
      .maybeSingle();
    if (error || !data) throw new Error("That school does not exist.");
    slug = data.slug as string;
  }

  return withAudit(
    actor,
    {
      action: "restore.drill_record",
      schoolId: d.schoolId,
      details: { slug: slug ?? "control-plane", ok: d.ok, seconds, backup_id: d.backupId },
    },
    async () => {
      const { data, error } = await admin.rpc("record_restore_drill", {
        p_school: d.schoolId,
        p_backup: d.backupId,
        p_ok: d.ok,
        p_seconds: seconds,
        p_notes: d.notes,
        p_by: actor.email,
      });
      if (error) throw new Error(error.message);
      return { id: data as string };
    }
  );
}
