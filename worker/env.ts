import { hostname } from "node:os";
import { z } from "zod";

// The worker's own environment. It is NOT the web app's: the dashboard never
// holds school database URLs or the deploy key, and the worker never needs the
// browser-facing Supabase settings.

const schema = z.object({
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  SCHOOL_DB_URLS: z.string().min(2),
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
  WORKER_ID: z.string().min(1).default(`${hostname()}-${process.pid}`),
  POLL_MS: z.coerce.number().int().min(500).max(60_000).default(3000),
  STALE_MINUTES: z.coerce.number().int().min(5).max(240).default(45),
  SCAN_EVERY_MINUTES: z.coerce.number().int().min(5).max(1440).default(30),
});

export type WorkerEnv = z.infer<typeof schema>;

export function loadWorkerEnv(source: Record<string, string | undefined> = process.env): WorkerEnv {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`);
    throw new Error(`The worker's environment is incomplete:\n${lines.join("\n")}`);
  }
  return parsed.data;
}
