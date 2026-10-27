import { z } from "zod";

// Validated once, when first imported on the server. A missing value stops the
// app with a message naming it, instead of failing later inside a request.
const schema = z.object({
  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  // Bearer token for the scheduled health run. Optional: without it the cron
  // route refuses every call.
  CRON_SECRET: z.string().min(32, "Use at least 32 characters.").optional(),
  // JSON map of school slug -> that school's service-role key, used to push
  // licences. Optional: without it licence pushes are refused.
  SCHOOL_SERVICE_KEYS: z.string().optional(),
  // JSON map of school slug -> that school's IMPERSONATION_SIGNING_SECRET, used
  // to sign read-only support links. Optional: without it support links are
  // refused. Interim, like SCHOOL_SERVICE_KEYS.
  SCHOOL_SIGNING_SECRETS: z.string().optional(),
  // Who the invoice and receipt PDFs come from. Optional: without a name the PDFs
  // carry no issuer heading. LINES is separated by "|" (address, bank details...).
  BILLING_ISSUER_NAME: z.string().max(80).optional(),
  BILLING_ISSUER_LINES: z.string().max(400).optional(),
});

const parsed = schema.safeParse({
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  CRON_SECRET: process.env.CRON_SECRET || undefined,
  SCHOOL_SERVICE_KEYS: process.env.SCHOOL_SERVICE_KEYS || undefined,
  SCHOOL_SIGNING_SECRETS: process.env.SCHOOL_SIGNING_SECRETS || undefined,
  BILLING_ISSUER_NAME: process.env.BILLING_ISSUER_NAME || undefined,
  BILLING_ISSUER_LINES: process.env.BILLING_ISSUER_LINES || undefined,
});

if (!parsed.success) {
  const problems = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
  throw new Error(`Invalid environment configuration: ${problems}`);
}

export const env = parsed.data;
