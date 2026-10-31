import { describe, expect, it, vi } from "vitest";
import type { Run, RunResult } from "@/worker/backup";
import { makeStorageCheck } from "@/worker/storage-check";

const cfg = {
  endpoint: "https://acct123.r2.cloudflarestorage.com",
  bucket: "greenfield-files",
  accessKeyId: "AKIAEXAMPLEKEYID",
  secretAccessKey: "super-secret-access-key",
};
const done = (over: Partial<RunResult> = {}): RunResult => ({
  code: 0,
  stdout: "",
  stderr: "",
  timedOut: false,
  ...over,
});
const verb = (args: string[]) => args[1];

describe("storage check", () => {
  it("finds the bucket, writes, reads and deletes a probe object, then reports ok", async () => {
    const run = vi.fn<Run>(async () => done());
    expect(await makeStorageCheck(run)(cfg)).toEqual({ ok: true });
    expect(run.mock.calls.map((c) => verb(c[1]))).toEqual([
      "head-bucket",
      "put-object",
      "head-object",
      "delete-object",
    ]);
    const [, args] = run.mock.calls[1];
    expect(args).toContain("--endpoint-url");
    expect(args[args.indexOf("--key") + 1]).toMatch(/^\.provision-check\/[0-9a-f]{16}$/);
  });

  it("gives the keys only through the environment, and nothing else is inherited", async () => {
    const run = vi.fn<Run>(async () => done());
    await makeStorageCheck(run)(cfg);
    const [, args, opts] = run.mock.calls[0];
    expect(args.join(" ")).not.toContain(cfg.secretAccessKey);
    expect(opts.env).toMatchObject({
      AWS_ACCESS_KEY_ID: cfg.accessKeyId,
      AWS_SECRET_ACCESS_KEY: cfg.secretAccessKey,
    });
    expect(Object.keys(opts.env).every((k) => /^(PATH|HOME|AWS_)/.test(k))).toBe(true);
  });

  it("stops at a missing bucket and says which step failed, hiding the keys", async () => {
    const run = vi.fn<Run>(async () =>
      done({ code: 255, stderr: `NoSuchBucket for ${cfg.secretAccessKey} / ${cfg.accessKeyId}` })
    );
    const out = await makeStorageCheck(run)(cfg);
    expect(out).toMatchObject({
      ok: false,
      error: expect.stringMatching(/^Finding the bucket failed/),
    });
    expect(JSON.stringify(out)).not.toContain(cfg.secretAccessKey);
    expect(JSON.stringify(out)).not.toContain(cfg.accessKeyId);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("reports a key that cannot write", async () => {
    const run = vi.fn<Run>(async (_c, args) =>
      verb(args) === "put-object" ? done({ code: 1, stderr: "AccessDenied" }) : done()
    );
    const out = await makeStorageCheck(run)(cfg);
    expect(out).toMatchObject({
      ok: false,
      error: expect.stringMatching(/Writing to the bucket failed.*AccessDenied/),
    });
    expect(run.mock.calls.map((c) => verb(c[1]))).toEqual(["head-bucket", "put-object"]);
  });

  it("tries to remove the probe object when reading it back fails", async () => {
    const run = vi.fn<Run>(async (_c, args) =>
      verb(args) === "head-object" ? done({ code: 1, stderr: "not found" }) : done()
    );
    const out = await makeStorageCheck(run)(cfg);
    expect(out.ok).toBe(false);
    expect(run.mock.calls.map((c) => verb(c[1]))).toEqual([
      "head-bucket",
      "put-object",
      "head-object",
      "delete-object",
    ]);
  });

  it("reports a timeout", async () => {
    const run = vi.fn<Run>(async () => done({ code: null, timedOut: true }));
    expect(await makeStorageCheck(run)(cfg)).toMatchObject({ ok: false, error: /timed out/ });
  });
});
