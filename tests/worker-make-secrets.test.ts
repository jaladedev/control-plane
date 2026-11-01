import { describe, expect, it } from "vitest";
import { makeSecrets, secretsFromProcessEnv } from "@/worker/make-secrets";
import { EnvSecrets } from "@/worker/secrets";

const DB = '{"greenfield":"postgresql://postgres:s3cretPassw0rd@db.abc.supabase.co:5432/postgres"}';

describe("makeSecrets", () => {
  it("uses the environment when no Infisical credentials are set", async () => {
    const s = await makeSecrets({ SCHOOL_DB_URLS: DB });
    expect(s).toBeInstanceOf(EnvSecrets);
    expect(await s.schoolDatabaseUrl("greenfield")).toContain("db.abc.supabase.co");
  });

  it("refuses an environment that has nothing in it, naming the setting", async () => {
    await expect(makeSecrets({})).rejects.toThrow(/SCHOOL_DB_URLS is not set/);
  });

  it("uses Infisical when its credentials are set, and stops at once if it cannot sign in", async () => {
    // Port 9 (discard) on this machine: refused immediately, with no network traffic.
    const attempt = makeSecrets({
      INFISICAL_URL: "http://127.0.0.1:9",
      INFISICAL_CLIENT_ID: "cid",
      INFISICAL_CLIENT_SECRET: "csecret",
      INFISICAL_PROJECT_ID: "proj",
    });
    await expect(attempt).rejects.toThrow("Infisical could not be reached.");
  });
});

describe("secretsFromProcessEnv", () => {
  it("reads SCHOOL_DB_URLS for scripts, as the worker does", async () => {
    const s = await secretsFromProcessEnv({ SCHOOL_DB_URLS: DB });
    expect(s).toBeInstanceOf(EnvSecrets);
  });

  it("refuses to guess when both places are set, or neither", async () => {
    await expect(
      secretsFromProcessEnv({
        SCHOOL_DB_URLS: DB,
        INFISICAL_CLIENT_ID: "cid",
        INFISICAL_CLIENT_SECRET: "csecret",
        INFISICAL_PROJECT_ID: "proj",
      })
    ).rejects.toThrow(/remove SCHOOL_DB_URLS and SCHOOL_APP_ENVS/);
    await expect(secretsFromProcessEnv({})).rejects.toThrow(
      /SCHOOL_DB_URLS: set it, or set INFISICAL_/
    );
  });

  it("needs all three Infisical credentials", async () => {
    await expect(secretsFromProcessEnv({ INFISICAL_CLIENT_ID: "cid" })).rejects.toThrow(
      /INFISICAL_PROJECT_ID/
    );
  });
});
