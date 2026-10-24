import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

// In the CI job that provides Postgres, RUNNER_TEST_REQUIRED=1 turns "the
// integration tests were skipped" into a failure.
describe("integration test environment", () => {
  const required = process.env.RUNNER_TEST_REQUIRED === "1";

  it.skipIf(!required)("has a Postgres connection when one is required", () => {
    expect(
      process.env.RUNNER_TEST_PG,
      "RUNNER_TEST_PG must be set when RUNNER_TEST_REQUIRED=1"
    ).toBeTruthy();
  });

  // The backup tests skip unless all of this is present; a skip would hide a
  // broken backup pipeline, so in CI each missing piece is a failure.
  it.skipIf(!required)("has an S3-compatible endpoint for the backup tests", () => {
    expect(
      process.env.BACKUP_TEST_S3_ENDPOINT,
      "BACKUP_TEST_S3_ENDPOINT must be set when RUNNER_TEST_REQUIRED=1"
    ).toBeTruthy();
  });

  it.skipIf(!required).each(["pg_dump", "pg_restore", "age", "age-keygen", "aws"])(
    "has %s on the PATH for the backup tests",
    (tool) => {
      expect(spawnSync(tool, ["--version"]).status, `${tool} must be installed`).toBe(0);
    }
  );
});
