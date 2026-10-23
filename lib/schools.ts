import { z } from "zod";

// What a school record may contain, and how licence state is read from it.
// Pure, so it can be tested without a database.

export const SCHOOL_STATUSES = ["provisioning", "active", "suspended", "archived"] as const;
export type SchoolStatus = (typeof SCHOOL_STATUSES)[number];

export const HOSTING_PLANS = ["free", "pro"] as const;

// Names that only mean something inside a private network. The health cron
// fetches these hostnames from the public internet, so they are refused.
const PRIVATE_SUFFIXES = [".local", ".internal", ".localhost", ".lan", ".home", ".arpa", ".test"];
const HOSTNAME = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** A lowercase DNS name with a dot, or an Error. No ports, paths, IPs or private names. */
export function normalizeHostname(input: string): string {
  const host = input.trim().toLowerCase();
  if (!HOSTNAME.test(host)) {
    throw new Error(
      `"${input.trim()}" is not a valid hostname (use a name like school.example.com).`
    );
  }
  if (PRIVATE_SUFFIXES.some((s) => host.endsWith(s))) {
    throw new Error(`"${host}" is a private name; use the school's public hostname.`);
  }
  return host;
}

/** Splits a comma/space/newline separated list, validates and de-duplicates it. */
export function parseHostnames(raw: string): string[] {
  const parts = raw
    .split(/[\s,]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length > 5) throw new Error("Use at most 5 hostnames.");
  return [...new Set(parts.map(normalizeHostname))];
}

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === "" ? null : v))
    .nullable()
    .optional()
    .transform((v) => v ?? null);

const optionalEmail = z
  .string()
  .trim()
  .toLowerCase()
  .max(200)
  .transform((v) => (v === "" ? null : v))
  .nullable()
  .optional()
  .transform((v) => v ?? null)
  .refine((v) => v === null || z.string().email().safeParse(v).success, "Enter a valid email.");

// Fields an owner can edit. The slug is not here: it is fixed at creation
// because the school's SCHOOL_SLUG setting must keep matching it.
export const schoolDetailsSchema = z.object({
  name: z.string().trim().min(2, "Enter the school's name.").max(120),
  hostnames: z.string().transform((v, ctx) => {
    try {
      return parseHostnames(v);
    } catch (e) {
      ctx.addIssue({
        code: "custom",
        message: e instanceof Error ? e.message : "Invalid hostnames.",
      });
      return z.NEVER;
    }
  }),
  included_students: z.coerce.number().int().min(0).max(1_000_000),
  hosting_plan: z.enum(HOSTING_PLANS),
  billing_contact_name: optionalText(120),
  billing_contact_email: optionalEmail,
  region: optionalText(60),
  supabase_project_ref: optionalText(40),
  supabase_account_email: optionalEmail,
  cloudflare_account_email: optionalEmail,
  r2_bucket: optionalText(100),
  container_name: optionalText(100),
});
export type SchoolDetails = z.infer<typeof schoolDetailsSchema>;

export const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/,
    "Slug: 3-40 characters, lowercase letters, digits and hyphens."
  );

export type LicenseState = "none" | "active" | "grace" | "expired";

/** Same rule as license_status() in a school's database: derived from the clock. */
export function licenseState(
  license: { license_valid_until: string | null; license_grace_until: string | null },
  now: Date = new Date()
): LicenseState {
  if (!license.license_valid_until || !license.license_grace_until) return "none";
  if (now <= new Date(license.license_valid_until)) return "active";
  if (now <= new Date(license.license_grace_until)) return "grace";
  return "expired";
}
