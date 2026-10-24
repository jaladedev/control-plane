import { describe, expect, it } from "vitest";

// In the CI job that provides Postgres, RUNNER_TEST_REQUIRED=1 turns "the
// integration tests were skipped" into a failure.
describe("integration test environment", () => {
  it.skipIf(process.env.RUNNER_TEST_REQUIRED !== "1")(
    "has a Postgres connection when one is required",
    () => {
      expect(
        process.env.RUNNER_TEST_PG,
        "RUNNER_TEST_PG must be set when RUNNER_TEST_REQUIRED=1"
      ).toBeTruthy();
    }
  );
});
