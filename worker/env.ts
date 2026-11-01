import { hostname } from "node:os";
import { z } from "zod";

// The worker's own environment. It is NOT the web app's: the dashboard never
// holds school database URLs or the deploy key, and the worker never needs the
// browser-facing Supabase settings.

// The Infisical settings, shared with scripts that run outside the worker.
export const infisicalShape = {
  INFISICAL_URL: z.string().url().default("https://app.infisical.com"),
  INFISICAL_CLIENT_ID: z.string().min(1).optional(),
  INFISICAL_CLIENT_SECRET: z.string().min(1).optional(),
  INFISICAL_PROJECT_ID: z.string().min(1).optional(),
  INFISICAL_ENVIRONMENT: z.string().min(1).default("prod"),
  INFISICAL_SECRETS_PATH: z
    .string()
    .regex(/^\/[A-Za-z0-9._/-]*$/, "must be a folder path like /schools")
    .refine((v) => !v.includes(".."), "must be a folder path like /schools")
    .default("/schools"),
  INFISICAL_CACHE_SECONDS: z.coerce.number().int().min(10).max(3600).default(60),
};

const base = z.object({
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  // School credentials come from ONE of two places (see backendProblems below): these
  // two settings, or Infisical.
  SCHOOL_DB_URLS: z.string().min(2).optional(),
  // Per school, the settings its container starts with (its Supabase project, R2
  // bucket and keys, signing secret). Only needed to provision a new school.
  SCHOOL_APP_ENVS: z.string().optional(),
  // Infisical: one folder per school under INFISICAL_SECRETS_PATH, read with a machine
  // identity (Universal Auth). docs/secrets.md.
  ...infisicalShape,
  SCHOOL_DB_CA_FILE: z.string().optional(),
  DEPLOY_SSH_HOST: z.string().min(1),
  DEPLOY_SSH_USER: z.string().default("root"),
  DEPLOY_SSH_KEY_FILE: z.string().min(1),
  DEPLOY_SSH_KNOWN_HOSTS: z.string().min(1),
  // Backups taken before a school's migrations run. Required: a worker that
  // cannot back up must not be the one migrating school databases.
  BACKUP_AGE_RECIPIENT: z
    .string()
    .regex(/^age1[0-9a-z]{20,}$/, "must be an age public key (age1...)"),
  R2_ENDPOINT: z.string().url(),
  R2_BUCKET: z.string().min(1),
  R2_ACCESS_KEY_ID: z.string().min(1),
  R2_SECRET_ACCESS_KEY: z.string().min(1),
  BACKUP_PREFIX: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/, "has characters it should not")
    .refine((v) => !v.endsWith("/") && !v.includes(".."), "has characters it should not")
    .default("schools"),
  BACKUP_KEEP: z.coerce.number().int().min(3).max(100).default(10),
  BACKUP_TIMEOUT_MINUTES: z.coerce.number().int().min(1).max(240).default(30),
  BACKUP_TMP_DIR: z.string().min(1).optional(),
  // Optional: lets the dashboard's "Register a release" read a commit's migrations.
  GITHUB_TOKEN: z.string().min(1).optional(),
  SCHOOL_APP_REPO: z
    .string()
    .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "must look like owner/name")
    .default("jaladedev/school_app"),
  // Optional: the control plane's own Telegram bot, for new-claim notices and the
  // 48-hour reminder. Without both, claim notices fail visibly (claims still queue).
  TELEGRAM_BOT_TOKEN: z.string().min(1).optional(),
  TELEGRAM_CHAT_ID: z.string().min(1).optional(),
  // Optional: email through Resend, for invoice reminders to a school's billing contact.
  // Both or neither. Without them a reminder job fails visibly (nothing is marked sent).
  RESEND_API_KEY: z.string().min(1).optional(),
  EMAIL_FROM_ADDRESS: z.string().min(3).max(300).optional(),
  // Where replies go (you, not a no-reply address).
  EMAIL_REPLY_TO: z.string().email().optional(),
  // Where the dashboard lives, for the link in a notice.
  APP_URL: z.string().url().optional(),
  WORKER_ID: z.string().min(1).default(`${hostname()}-${process.pid}`),
  POLL_MS: z.coerce.number().int().min(500).max(60_000).default(3000),
  STALE_MINUTES: z.coerce.number().int().min(5).max(240).default(45),
  // Suspend a school once its licence, grace included, ended this many days ago and
  // it has no open invoice or waiting claim. 0 turns this off.
  AUTO_SUSPEND_AFTER_DAYS: z.coerce
    .number()
    .int()
    .refine((v) => v === 0 || (v >= 7 && v <= 365), "must be 0 (off) or 7 to 365")
    .default(90),
  SCAN_EVERY_MINUTES: z.coerce.number().int().min(5).max(1440).default(30),
});

const schema = base.refine((e) => Boolean(e.RESEND_API_KEY) === Boolean(e.EMAIL_FROM_ADDRESS), {
  path: ["EMAIL_FROM_ADDRESS"],
  message: "RESEND_API_KEY and EMAIL_FROM_ADDRESS must be set together, or neither.",
});

export type WorkerEnv = z.infer<typeof schema>;

/** True when school credentials come from Infisical. */
export const usesInfisical = (e: Pick<WorkerEnv, "INFISICAL_CLIENT_ID">) =>
  Boolean(e.INFISICAL_CLIENT_ID);

/**
 * Credentials come from exactly one place. With Infisical, the database URLs and
 * container settings must NOT also sit in this environment: leaving them there would
 * defeat the point and leave two sources that can disagree.
 */
export function backendProblems(source: Record<string, string | undefined>): string[] {
  const set = (k: string) => Boolean(source[k]);
  const infisical = ["INFISICAL_CLIENT_ID", "INFISICAL_CLIENT_SECRET", "INFISICAL_PROJECT_ID"];
  if (infisical.some(set)) {
    const problems = infisical
      .filter((k) => !set(k))
      .map((k) => `${k}: required when using Infisical (all three of its credentials are needed)`);
    if (set("SCHOOL_DB_URLS") || set("SCHOOL_APP_ENVS")) {
      problems.push(
        "SCHOOL_DB_URLS: remove SCHOOL_DB_URLS and SCHOOL_APP_ENVS when Infisical is used, so the secrets live in one place"
      );
    }
    return problems;
  }
  return set("SCHOOL_DB_URLS")
    ? []
    : [
        "SCHOOL_DB_URLS: set it, or set INFISICAL_CLIENT_ID, INFISICAL_CLIENT_SECRET and INFISICAL_PROJECT_ID",
      ];
}

export function loadWorkerEnv(source: Record<string, string | undefined> = process.env): WorkerEnv {
  const parsed = schema.safeParse(source);
  const backend = backendProblems(source);
  if (!parsed.success || backend.length > 0) {
    const lines = [
      ...(parsed.success
        ? []
        : parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`)),
      ...backend.map((p) => `  ${p}`),
    ];
    throw new Error(`The worker's environment is incomplete:\n${lines.join("\n")}`);
  }
  return parsed.data;
}
