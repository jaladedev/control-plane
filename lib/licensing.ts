import { z } from "zod";

// Turning the licence form into the values a school's set_license() takes.
// Pure, so it can be tested without a database.

export const LICENSE_DEFAULTS = { trialDays: 30, graceDays: 14 } as const;

const DAY_MS = 86_400_000;
const FEATURE = /^[a-z][a-z0-9_]{1,39}$/;

export const licenseInputSchema = z.object({
  kind: z.enum(["trial", "paid"]),
  session: z.string().trim().min(1, "Enter the academic session (for example 2026/2027).").max(40),
  valid_until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick a valid-until date."),
  grace_days: z.coerce.number().int().min(0).max(90),
  student_cap: z
    .string()
    .optional()
    .transform((raw, ctx) => {
      const text = (raw ?? "").trim();
      if (text === "") return null; // blank means no cap
      const n = Number(text);
      if (!Number.isInteger(n) || n <= 0) {
        ctx.addIssue({ code: "custom", message: "Student cap must be a positive whole number." });
        return z.NEVER;
      }
      return n;
    }),
  features: z
    .string()
    .default("")
    .transform((raw, ctx) => {
      const list = [
        ...new Set(
          raw
            .split(/[\s,]+/)
            .map((f) => f.trim().toLowerCase())
            .filter(Boolean)
        ),
      ];
      if (list.length > 20) ctx.addIssue({ code: "custom", message: "Use at most 20 add-ons." });
      const bad = list.find((f) => !FEATURE.test(f));
      if (bad) {
        ctx.addIssue({
          code: "custom",
          message: `Add-on "${bad}" is not valid (lowercase letters, digits and underscores).`,
        });
      }
      return list;
    }),
});

export type LicenseInput = z.infer<typeof licenseInputSchema>;

export type LicenseValues = {
  session: string;
  is_trial: boolean;
  valid_until: string; // ISO
  grace_until: string; // ISO
  student_cap: number | null;
  features: string[];
};

/** Valid until the END of the chosen day (UTC); grace runs on from there. */
export function buildLicense(input: LicenseInput, now: Date = new Date()): LicenseValues {
  const validUntil = new Date(`${input.valid_until}T23:59:59.000Z`);
  if (Number.isNaN(validUntil.getTime())) throw new Error("Pick a valid-until date.");
  if (validUntil.getTime() < now.getTime()) {
    throw new Error("Valid-until is in the past. To end a licence now, use Revoke.");
  }
  if (validUntil.getTime() > now.getTime() + 3 * 366 * DAY_MS) {
    throw new Error("Valid-until is more than three years away; check the date.");
  }
  return {
    session: input.session,
    is_trial: input.kind === "trial",
    valid_until: validUntil.toISOString(),
    grace_until: new Date(validUntil.getTime() + input.grace_days * DAY_MS).toISOString(),
    student_cap: input.student_cap,
    features: input.features,
  };
}

/** Prefill for the form: today plus the default trial length. */
export function defaultValidUntil(now: Date = new Date()): string {
  return new Date(now.getTime() + LICENSE_DEFAULTS.trialDays * DAY_MS).toISOString().slice(0, 10);
}

/** Saved but the school has not accepted it yet. */
export function isUnsynced(school: { license_version: number; license_pushed_version: number }) {
  return school.license_version > school.license_pushed_version;
}
