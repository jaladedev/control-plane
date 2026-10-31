import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnRun, type Run } from "@/worker/backup";

// Checks that a school's R2 bucket exists and that ITS access key can write,
// read and delete in it, before the school's container is started with that
// key. Uses the aws CLI the backup already needs. The probe object is written
// under a prefix of its own and removed straight away.

export type StorageConfig = {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
};
export type StorageResult = { ok: true } | { ok: false; error: string };
export type StorageCheck = (cfg: StorageConfig) => Promise<StorageResult>;

const clip = (s: string, n = 400) => {
  const t = s.trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

export function makeStorageCheck(run: Run = spawnRun, timeoutMs = 60_000): StorageCheck {
  return async (cfg) => {
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      AWS_ACCESS_KEY_ID: cfg.accessKeyId,
      AWS_SECRET_ACCESS_KEY: cfg.secretAccessKey,
      AWS_DEFAULT_REGION: "auto",
      AWS_EC2_METADATA_DISABLED: "true",
    };
    if (process.env.HOME) env.HOME = process.env.HOME;
    const scrub = (text: string) =>
      [cfg.secretAccessKey, cfg.accessKeyId]
        .filter((s) => s.length >= 6)
        .reduce((out, s) => out.split(s).join("[secret]"), text);

    const key = `.provision-check/${randomBytes(8).toString("hex")}`;
    const base = ["--endpoint-url", cfg.endpoint];
    const dir = await mkdtemp(join(tmpdir(), "storage-check-"));
    const body = join(dir, "probe.txt");
    await writeFile(body, "provisioning check\n");

    const step = async (what: string, args: string[]): Promise<string | null> => {
      const res = await run("aws", args, { env, timeoutMs });
      if (res.timedOut) return `${what} timed out.`;
      if (res.code !== 0) return `${what} failed: ${clip(scrub(res.stderr || res.stdout))}`;
      return null;
    };

    try {
      const steps: [string, string[]][] = [
        ["Finding the bucket", ["s3api", "head-bucket", ...base, "--bucket", cfg.bucket]],
        [
          "Writing to the bucket",
          ["s3api", "put-object", ...base, "--bucket", cfg.bucket, "--key", key, "--body", body],
        ],
        [
          "Reading from the bucket",
          ["s3api", "head-object", ...base, "--bucket", cfg.bucket, "--key", key],
        ],
        [
          "Deleting from the bucket",
          ["s3api", "delete-object", ...base, "--bucket", cfg.bucket, "--key", key],
        ],
      ];
      for (const [what, args] of steps) {
        const failure = await step(what, args);
        if (failure) {
          // Best effort: do not leave the probe object behind if only the later steps failed.
          if (what !== "Finding the bucket" && what !== "Writing to the bucket") {
            await run(
              "aws",
              ["s3api", "delete-object", ...base, "--bucket", cfg.bucket, "--key", key],
              { env, timeoutMs }
            ).catch(() => {});
          }
          return { ok: false, error: failure };
        }
      }
      return { ok: true };
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  };
}
