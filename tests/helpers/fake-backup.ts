import { vi } from "vitest";
import type { BackupProvider, BackupRequest } from "@/worker/backup";

// A BackupProvider that keeps an in-memory "bucket": it records what it was
// asked to create and remove, and returns a plausible artifact.
export function fakeBackup(overrides: Partial<BackupProvider> = {}) {
  const created: BackupRequest[] = [];
  const removed: string[] = [];
  const provider: BackupProvider & { created: BackupRequest[]; removed: string[] } = {
    created,
    removed,
    create: vi.fn(async (req: BackupRequest) => {
      created.push(req);
      return {
        objectKey: `schools/${req.slug}/${created.length}.dump.age`,
        sizeBytes: 4096,
        sha256: "a".repeat(64),
      };
    }),
    remove: vi.fn(async (key: string) => {
      removed.push(key);
    }),
    ...overrides,
  };
  return provider;
}
