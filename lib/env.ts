import { z } from "zod";
import { accessConfigFromEnv } from "@/lib/cf-access";

// Validated once, when first imported on the server. A missing value stops the
// app with a message naming it, instead of failing later inside a request.
const schema = z
  .object({
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
    // The control plane's own bucket for proofs of payment. All four or none: without
    // them the proof endpoints answer "not set up" and claims go without a proof.
    PROOF_R2_ENDPOINT: z.string().url().optional(),
    PROOF_R2_BUCKET: z.string().min(3).max(63).optional(),
    PROOF_R2_ACCESS_KEY_ID: z.string().min(8).optional(),
    PROOF_R2_SECRET_ACCESS_KEY: z.string().min(16).optional(),
    // Your one Paystack account's SECRET key (sk_live_... or sk_test_...). Used to start a
    // checkout and to check the signature on Paystack's webhooks. Without it, card
    // payments answer "not available" and schools pay by transfer.
    PAYSTACK_SECRET_KEY: z
      .string()
      .regex(/^sk_(live|test)_[A-Za-z0-9]{10,}$/)
      .optional(),
    // Cloudflare Access, checked again at the app (docs/cloudflare-access.md). Both or none.
    CF_ACCESS_TEAM_DOMAIN: z.string().optional(),
    CF_ACCESS_AUD: z.string().optional(),
    BILLING_ISSUER_NAME: z.string().max(80).optional(),
    BILLING_ISSUER_LINES: z.string().max(400).optional(),
  })
  .superRefine((value, ctx) => {
    // The proof bucket settings come as a set: a half-filled set is a mistake.
    const proof = [
      "PROOF_R2_ENDPOINT",
      "PROOF_R2_BUCKET",
      "PROOF_R2_ACCESS_KEY_ID",
      "PROOF_R2_SECRET_ACCESS_KEY",
    ] as const;
    try {
      accessConfigFromEnv({
        CF_ACCESS_TEAM_DOMAIN: value.CF_ACCESS_TEAM_DOMAIN,
        CF_ACCESS_AUD: value.CF_ACCESS_AUD,
      });
    } catch (error) {
      ctx.addIssue({
        code: "custom",
        path: ["CF_ACCESS_TEAM_DOMAIN"],
        message: error instanceof Error ? error.message : "Invalid Cloudflare Access settings.",
      });
    }
    const missing = proof.filter((k) => !value[k]);
    if (missing.length > 0 && missing.length < proof.length) {
      for (const k of missing) {
        ctx.addIssue({
          code: "custom",
          path: [k],
          message: "Set all four PROOF_R2_* values, or none.",
        });
      }
    }
  });

const parsed = schema.safeParse({
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  CRON_SECRET: process.env.CRON_SECRET || undefined,
  SCHOOL_SERVICE_KEYS: process.env.SCHOOL_SERVICE_KEYS || undefined,
  SCHOOL_SIGNING_SECRETS: process.env.SCHOOL_SIGNING_SECRETS || undefined,
  PROOF_R2_ENDPOINT: process.env.PROOF_R2_ENDPOINT || undefined,
  PROOF_R2_BUCKET: process.env.PROOF_R2_BUCKET || undefined,
  PROOF_R2_ACCESS_KEY_ID: process.env.PROOF_R2_ACCESS_KEY_ID || undefined,
  PROOF_R2_SECRET_ACCESS_KEY: process.env.PROOF_R2_SECRET_ACCESS_KEY || undefined,
  PAYSTACK_SECRET_KEY: process.env.PAYSTACK_SECRET_KEY || undefined,
  CF_ACCESS_TEAM_DOMAIN: process.env.CF_ACCESS_TEAM_DOMAIN || undefined,
  CF_ACCESS_AUD: process.env.CF_ACCESS_AUD || undefined,
  BILLING_ISSUER_NAME: process.env.BILLING_ISSUER_NAME || undefined,
  BILLING_ISSUER_LINES: process.env.BILLING_ISSUER_LINES || undefined,
});

if (!parsed.success) {
  const problems = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
  throw new Error(`Invalid environment configuration: ${problems}`);
}

export const env = parsed.data;
