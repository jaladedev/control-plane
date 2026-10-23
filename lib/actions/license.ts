import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { createSchoolClient } from "@/lib/school-client";
import { requireActor, type Actor } from "@/lib/auth/guards";
import { withAudit } from "@/lib/audit";
import { buildLicense, licenseInputSchema, type LicenseValues } from "@/lib/licensing";

// Licences. Owner and finance may set, push and retry; only an owner may
// revoke. The desired state is saved on the school's registry row first (with
// a new, higher version), then pushed to the school's own database through
// set_license(). If the push fails the saved state stays, the error is shown
// on the school, and "Retry push" sends the same version again (set_license
// treats a repeat as a harmless no-op).

const MONEY_ROLES = ["owner", "finance"] as const;

type SchoolRow = {
  id: string;
  slug: string;
  status: string;
  supabase_project_ref: string | null;
  license_version: number;
  license_session: string | null;
  license_is_trial: boolean;
  license_valid_until: string | null;
  license_grace_until: string | null;
  included_students: number;
  features: string[];
};

const COLUMNS =
  "id, slug, status, supabase_project_ref, license_version, license_session, license_is_trial, license_valid_until, license_grace_until, included_students, features";

async function loadSchool(admin: ReturnType<typeof createAdminClient>, schoolId: string) {
  const id = z.string().uuid().parse(schoolId);
  const { data, error } = await admin.from("schools").select(COLUMNS).eq("id", id).single();
  if (error || !data) throw new Error("That school does not exist.");
  return data as SchoolRow;
}

async function push(
  schoolClient: SupabaseClient,
  schoolId: string,
  version: number,
  v: LicenseValues
): Promise<boolean> {
  const { data, error } = await schoolClient.rpc("set_license", {
    p_school_id: schoolId,
    p_version: version,
    p_session: v.session,
    p_valid_until: v.valid_until,
    p_grace_until: v.grace_until,
    p_student_cap: v.student_cap,
    p_features: v.features,
    p_is_trial: v.is_trial,
  });
  if (error) throw new Error(`The school did not accept the licence: ${error.message}`);
  // true: applied. false: the school already holds this version or a newer one.
  return data === true;
}

function savedValues(s: SchoolRow): LicenseValues {
  if (!s.license_valid_until || !s.license_grace_until || !s.license_session) {
    throw new Error("No licence has been set for this school yet.");
  }
  return {
    session: s.license_session,
    is_trial: s.license_is_trial,
    valid_until: s.license_valid_until,
    grace_until: s.license_grace_until,
    student_cap: s.included_students > 0 ? s.included_students : null,
    features: s.features ?? [],
  };
}

// Save version+1 on the registry row, push it, record the outcome. Called
// inside withAudit, so the audit row already exists.
async function saveAndPush(
  admin: ReturnType<typeof createAdminClient>,
  schoolClient: SupabaseClient,
  school: SchoolRow,
  values: LicenseValues
): Promise<number> {
  const version = school.license_version + 1;
  const { error: saveError } = await admin
    .from("schools")
    .update({
      license_version: version,
      license_session: values.session,
      license_is_trial: values.is_trial,
      license_valid_until: values.valid_until,
      license_grace_until: values.grace_until,
      included_students: values.student_cap ?? 0,
      features: values.features,
      license_push_error: null,
    })
    .eq("id", school.id);
  if (saveError) throw new Error(saveError.message);

  try {
    const applied = await push(schoolClient, school.id, version, values);
    if (!applied) {
      throw new Error(
        `The school already has licence version ${version} or newer, so it ignored this one.`
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Push failed.";
    await admin
      .from("schools")
      .update({ license_push_error: message.slice(0, 500) })
      .eq("id", school.id);
    throw new Error(`Saved as version ${version}, but not delivered. ${message} Use Retry push.`);
  }
  await admin
    .from("schools")
    .update({
      license_pushed_version: version,
      license_pushed_at: new Date().toISOString(),
      license_push_error: null,
    })
    .eq("id", school.id);
  return version;
}

function checkReady(school: SchoolRow) {
  if (school.status === "archived") throw new Error("This school is archived.");
  // Fails early (before anything is saved) if the project ref or key is missing.
  return createSchoolClient(school.slug, school.supabase_project_ref);
}

export async function setLicense(
  schoolId: string,
  input: Record<string, unknown>,
  now: Date = new Date()
): Promise<{ version: number }> {
  const actor = await requireActor(MONEY_ROLES);
  const values = buildLicense(licenseInputSchema.parse(input), now);
  const admin = createAdminClient();
  const school = await loadSchool(admin, schoolId);
  const schoolClient = checkReady(school);

  return withAudit(
    actor,
    {
      action: "license.set",
      schoolId: school.id,
      details: { slug: school.slug, from_version: school.license_version, ...values },
    },
    async () => ({ version: await saveAndPush(admin, schoolClient, school, values) })
  );
}

/** Sends the saved licence again (same version). Use after a failed push. */
export async function pushLicense(schoolId: string): Promise<void> {
  const actor = await requireActor(MONEY_ROLES);
  const admin = createAdminClient();
  const school = await loadSchool(admin, schoolId);
  const values = savedValues(school);
  const schoolClient = checkReady(school);

  await withAudit(
    actor,
    {
      action: "license.push",
      schoolId: school.id,
      details: { slug: school.slug, version: school.license_version },
    },
    async () => {
      try {
        await push(schoolClient, school.id, school.license_version, values);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Push failed.";
        await admin
          .from("schools")
          .update({ license_push_error: message.slice(0, 500) })
          .eq("id", school.id);
        throw error;
      }
      await admin
        .from("schools")
        .update({
          license_pushed_version: school.license_version,
          license_pushed_at: new Date().toISOString(),
          license_push_error: null,
        })
        .eq("id", school.id);
    }
  );
}

/**
 * Ends the licence now: valid and grace both end this moment, so the school
 * becomes read-only for everyone. Owner only. Reversible by setting a new
 * licence (a higher version).
 */
export async function revokeLicense(
  schoolId: string,
  confirm: unknown,
  now: Date = new Date()
): Promise<{ version: number }> {
  const actor = await requireActor(["owner"]);
  if (confirm !== "yes") throw new Error("Tick the box to confirm the revoke.");
  const admin = createAdminClient();
  const school = await loadSchool(admin, schoolId);
  const schoolClient = checkReady(school);

  const ends = now.toISOString();
  const values: LicenseValues = {
    session: school.license_session ?? "revoked",
    is_trial: school.license_is_trial,
    valid_until: ends,
    grace_until: ends,
    student_cap: school.included_students > 0 ? school.included_students : null,
    features: school.features ?? [],
  };

  return withAudit(
    actor,
    {
      action: "license.revoke",
      schoolId: school.id,
      details: { slug: school.slug, from_version: school.license_version, ends },
    },
    async () => ({ version: await saveAndPush(admin, schoolClient, school, values) })
  );
}
