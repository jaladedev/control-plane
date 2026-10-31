import { probeSchool } from "@/lib/health";
import { runDeployCommand } from "@/lib/deploy/client";
import { makeConnect } from "@/worker/connect";
import { loadWorkerEnv } from "@/worker/env";
import { ToolsBackupProvider } from "@/worker/backup";
import { EnvSecrets } from "@/worker/secrets";
import { makeStorageCheck } from "@/worker/storage-check";
import { supabaseAuthAdmin } from "@/worker/auth-admin";
import { fetchMigrationsAtCommit } from "@/lib/github-migrations";
import { sendTelegram } from "@/lib/billing/telegram";
import { SupabaseStore } from "@/worker/store";
import { runWorker } from "@/worker/run";

// Entry point: `npm run worker`. Reads its settings from the process
// environment (a systemd EnvironmentFile or a container --env-file), runs until
// it receives SIGTERM or SIGINT, and lets an in-flight job finish first.

async function main() {
  const env = loadWorkerEnv();
  const secrets = new EnvSecrets(env.SCHOOL_DB_URLS, env.SCHOOL_APP_ENVS);
  const log = (message: string) =>
    console.log(`${new Date().toISOString()} ${secrets.redact(message)}`);
  if (!env.SCHOOL_DB_CA_FILE) {
    log(
      "warning: SCHOOL_DB_CA_FILE is not set; school database connections are encrypted but the server is not verified."
    );
  }

  const controller = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      log(`${signal} received; finishing the current job, then stopping`);
      controller.abort();
    });
  }

  log(`worker ${env.WORKER_ID} starting`);
  await runWorker(
    {
      workerId: env.WORKER_ID,
      store: new SupabaseStore(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY),
      secrets,
      connect: makeConnect(env.SCHOOL_DB_CA_FILE),
      deploy: (cmd) =>
        runDeployCommand(
          {
            host: env.DEPLOY_SSH_HOST,
            user: env.DEPLOY_SSH_USER,
            keyFile: env.DEPLOY_SSH_KEY_FILE,
            knownHostsFile: env.DEPLOY_SSH_KNOWN_HOSTS,
          },
          cmd
        ),
      probe: (hostname, slug) => probeSchool(hostname, { expectedSlug: slug }),
      backup: new ToolsBackupProvider({
        ageRecipient: env.BACKUP_AGE_RECIPIENT,
        r2: {
          endpoint: env.R2_ENDPOINT,
          bucket: env.R2_BUCKET,
          accessKeyId: env.R2_ACCESS_KEY_ID,
          secretAccessKey: env.R2_SECRET_ACCESS_KEY,
        },
        prefix: env.BACKUP_PREFIX,
        caFile: env.SCHOOL_DB_CA_FILE,
        tmpDir: env.BACKUP_TMP_DIR,
        timeoutMs: env.BACKUP_TIMEOUT_MINUTES * 60_000,
      }),
      backupKeep: env.BACKUP_KEEP,
      checkStorage: makeStorageCheck(),
      authAdmin: supabaseAuthAdmin,
      fetchMigrations: env.GITHUB_TOKEN
        ? (sha) =>
            fetchMigrationsAtCommit({ repo: env.SCHOOL_APP_REPO, sha, token: env.GITHUB_TOKEN! })
        : undefined,
      telegram:
        env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID
          ? {
              send: (text) =>
                sendTelegram({
                  token: env.TELEGRAM_BOT_TOKEN!,
                  chatId: env.TELEGRAM_CHAT_ID!,
                  text,
                }),
              appUrl: env.APP_URL ?? null,
            }
          : undefined,
      log,
    },
    {
      pollMs: env.POLL_MS,
      staleMinutes: env.STALE_MINUTES,
      scanEveryMs: env.SCAN_EVERY_MINUTES * 60_000,
      autoSuspendAfterDays: env.AUTO_SUSPEND_AFTER_DAYS === 0 ? null : env.AUTO_SUSPEND_AFTER_DAYS,
      signal: controller.signal,
    }
  );
  log("worker stopped");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
