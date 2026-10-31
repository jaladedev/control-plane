import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireActor } from "@/lib/auth/guards";
import { withAudit } from "@/lib/audit";
import { buildLicense, licenseInputSchema } from "@/lib/licensing";

// The provisioning wizard's one action (plan M5). Owner only. It saves the
// school's first licence on its registry row (the worker delivers it to the
// school's own database when that exists), then queues the provisioning job.
// It never touches a school's database, the server or any secret: the worker
// does that, from its own environment.
//
// With licence fields it sets the licence and queues; without them it is a
// resume of a school whose licence is already saved.

export async function startProvisioning(
  schoolId: string,
  input: Record<string, unknown> = {},
  now: Date = new Date()
): Promise<{ jobId: string }> {
  const actor = await requireActor(["owner"]);
  const id = z.string().uuid().parse(schoolId);

  const admin = createAdminClient();
  const { data: school, error } = await admin
    .from("schools")
    .select("id, slug, status, included_students, features, license_version")
    .eq("id", id)
    .maybeSingle();
  if (error || !school) throw new Error("That school does not exist.");
  if (school.status !== "provisioning") {
    throw new Error(`${school.slug} is ${school.status}; only a school being provisioned can be.`);
  }

  // The first admin is optional on a resume (it is already saved), required the first time.
  const adminName = typeof input.admin_name === "string" ? input.admin_name.trim() : "";
  const adminEmail = typeof input.admin_email === "string" ? input.admin_email.trim() : "";
  const admin_ =
    adminName || adminEmail
      ? z
          .object({
            name: z.string().min(2, "Enter the first admin's name.").max(120),
            email: z.string().email("Enter a valid email for the first admin.").max(200),
          })
          .parse({ name: adminName, email: adminEmail })
      : null;

  const withLicense = typeof input.valid_until === "string" && input.valid_until !== "";
  const values = withLicense
    ? buildLicense(
        licenseInputSchema.parse({
          ...input,
          // The school's own numbers, not the form's: the cap is what it pays for.
          student_cap: school.included_students > 0 ? String(school.included_students) : "",
          features: (school.features ?? []).join(","),
        }),
        now
      )
    : null;

  return withAudit(
    actor,
    {
      action: "school.provision",
      schoolId: school.id,
      details: {
        slug: school.slug,
        resume: !withLicense,
        ...(values ? { license: values } : {}),
        ...(admin_ ? { first_admin_email: admin_.email.toLowerCase() } : {}),
      },
    },
    async () => {
      if (values) {
        const { error: saveError } = await admin
          .from("schools")
          .update({
            license_version: school.license_version + 1,
            license_session: values.session,
            license_is_trial: values.is_trial,
            license_valid_until: values.valid_until,
            license_grace_until: values.grace_until,
            license_push_error: null,
          })
          .eq("id", school.id);
        if (saveError) throw new Error(saveError.message);
      }
      if (admin_) {
        const { error: adminError } = await admin
          .from("schools")
          .update({ first_admin_name: admin_.name, first_admin_email: admin_.email.toLowerCase() })
          .eq("id", school.id);
        if (adminError) throw new Error(adminError.message);
      }
      // The database's refusals are written for people, so they pass through as they are.
      const { data, error: queueError } = await admin.rpc("queue_provision", {
        p_school: school.id,
        p_by: actor.email,
      });
      if (queueError) throw new Error(queueError.message);
      return { jobId: data as string };
    }
  );
}
