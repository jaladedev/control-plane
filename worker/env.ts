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
