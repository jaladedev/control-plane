// Builds the root-only env file a new school's container starts with
// (deploy/school.env.example in the school app). Pure, so it is tested without
// a server. The values come from the worker's own environment (SCHOOL_APP_ENVS),
// never from the dashboard or its database.
//
// The checks are the ones that catch a person's real mistakes: another school's
// project or bucket pasted in, a missing key, a typo in a key name.

export const REQUIRED_KEYS = [
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "R2_ENDPOINT",
  "R2_BUCKET",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "IMPERSONATION_SIGNING_SECRET",
] as const;

export const OPTIONAL_KEYS = [
  "PAYSTACK_PUBLIC_KEY",
  "PAYSTACK_SECRET_KEY",
  "RESEND_API_KEY",
  "EMAIL_FROM_ADDRESS",
  "TELEGRAM_BOT_TOKEN",
  "LICENSE_SUPPORT_EMAIL",
  "CONTROL_PLANE_URL",
  "CLAIM_SIGNING_KEY",
] as const;

// SCHOOL_SLUG is set from the school's slug, so it may be present but must agree.
const ALLOWED = new Set<string>([...REQUIRED_KEYS, ...OPTIONAL_KEYS, "SCHOOL_SLUG"]);

export type SchoolEnvCheck = {
  slug: string;
  /** From the registry; when set, the env must point at this project. */
  supabaseProjectRef?: string | null;
  /** From the registry; when set, the env must name this bucket. */
  r2Bucket?: string | null;
};

export type SchoolEnvResult = { ok: true; file: string } | { ok: false; errors: string[] };

/** Returns the env file text, or every reason it cannot be built (never a value). */
export function buildSchoolEnvFile(
  values: Record<string, string> | undefined,
  check: SchoolEnvCheck
): SchoolEnvResult {
  const errors: string[] = [];
  if (!values) {
    return {
      ok: false,
      errors: [`SCHOOL_APP_ENVS on the worker has no entry for "${check.slug}".`],
    };
  }

  for (const [key, value] of Object.entries(values)) {
    if (!ALLOWED.has(key)) {
      errors.push(`${key} is not a setting the school app reads (typo?). IMAGE_TAG is never set.`);
    }
    if (/[\r\n]/.test(value)) errors.push(`${key} contains a line break.`);
  }
  for (const key of REQUIRED_KEYS) {
    if (!values[key]?.trim()) errors.push(`${key} is missing.`);
  }

  if (values.SCHOOL_SLUG !== undefined && values.SCHOOL_SLUG !== check.slug) {
    errors.push(`SCHOOL_SLUG does not match "${check.slug}".`);
  }
  if ((values.IMPERSONATION_SIGNING_SECRET ?? "").length > 0) {
    if (values.IMPERSONATION_SIGNING_SECRET.length < 32) {
      errors.push("IMPERSONATION_SIGNING_SECRET must be at least 32 characters.");
    }
  }
  if (Boolean(values.CONTROL_PLANE_URL) !== Boolean(values.CLAIM_SIGNING_KEY)) {
    errors.push("CONTROL_PLANE_URL and CLAIM_SIGNING_KEY must be set together, or neither.");
  }

  if (values.SUPABASE_URL) {
    let host = "";
    try {
      const url = new URL(values.SUPABASE_URL);
      host = url.hostname;
      if (url.protocol !== "https:") errors.push("SUPABASE_URL must be an https address.");
    } catch {
      errors.push("SUPABASE_URL is not a valid address.");
    }
    if (check.supabaseProjectRef && host && host !== `${check.supabaseProjectRef}.supabase.co`) {
      errors.push(
        `SUPABASE_URL is not this school's project (the registry says ${check.supabaseProjectRef}).`
      );
    }
  }
  if (check.r2Bucket && values.R2_BUCKET && values.R2_BUCKET !== check.r2Bucket) {
    errors.push(`R2_BUCKET is not this school's bucket (the registry says ${check.r2Bucket}).`);
  }
  if (values.R2_ENDPOINT) {
    try {
      const path = new URL(values.R2_ENDPOINT).pathname;
      if (path !== "/" && path !== "") {
        errors.push("R2_ENDPOINT must not include the bucket name or a path.");
      }
    } catch {
      errors.push("R2_ENDPOINT is not a valid address.");
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  const lines = Object.entries(values)
    .filter(([key, value]) => key !== "SCHOOL_SLUG" && value !== "")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`);
  return { ok: true, file: [`SCHOOL_SLUG=${check.slug}`, ...lines].join("\n") + "\n" };
}
