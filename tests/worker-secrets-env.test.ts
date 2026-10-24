import { describe, expect, it } from "vitest";
import { EnvSecrets } from "@/worker/secrets";
import { loadWorkerEnv } from "@/worker/env";
import { sslOptions } from "@/worker/connect";

const URL_G = "postgres://postgres:s3cretPassw0rd@db.abcdefghij.supabase.co:5432/postgres";

describe("EnvSecrets", () => {
  const secrets = new EnvSecrets(
    JSON.stringify({ greenfield: URL_G, bluefield: "postgres://u:otherpass123@h.example.com/db" })
  );

  it("returns the right school's URL and never another's", async () => {
    expect(await secrets.schoolDatabaseUrl("greenfield")).toBe(URL_G);
    await expect(secrets.schoolDatabaseUrl("redfield")).rejects.toThrow(
      /No database URL for "redfield"/
    );
  });

  it("explains a missing or malformed variable without echoing it", () => {
    expect(() => new EnvSecrets(undefined)).toThrow(/not set/);
    expect(() => new EnvSecrets("{broken " + URL_G)).toThrow(/must be JSON/);
    try {
      new EnvSecrets("{broken " + URL_G);
    } catch (e) {
      expect(String(e)).not.toContain("s3cretPassw0rd");
    }
    expect(() => new EnvSecrets(JSON.stringify({ a: 5 }))).toThrow(/must be JSON/);
  });

  it("redacts whole URLs and bare passwords from any message", () => {
    expect(secrets.redact(`connect failed for ${URL_G}`)).toBe("connect failed for [database url]");
    expect(
      secrets.redact("password authentication failed: s3cretPassw0rd was wrong")
    ).not.toContain("s3cretPassw0rd");
    expect(secrets.redact("otherpass123 leaked")).toContain("[secret]");
  });

  it("leaves harmless text alone", () => {
    expect(secrets.redact("relation x does not exist")).toBe("relation x does not exist");
  });
});

describe("loadWorkerEnv", () => {
  const good = {
    SUPABASE_URL: "https://abc.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "k",
    SCHOOL_DB_URLS: "{}",
    DEPLOY_SSH_HOST: "203.0.113.10",
    DEPLOY_SSH_KEY_FILE: "/k",
    DEPLOY_SSH_KNOWN_HOSTS: "/kh",
  };

  it("fills defaults", () => {
    const env = loadWorkerEnv(good);
    expect(env).toMatchObject({
      DEPLOY_SSH_USER: "root",
      POLL_MS: 3000,
      STALE_MINUTES: 45,
      SCAN_EVERY_MINUTES: 30,
    });
    expect(env.WORKER_ID.length).toBeGreaterThan(0);
  });

  it("lists every missing setting at once", () => {
    expect(() => loadWorkerEnv({})).toThrow(
      /SUPABASE_URL[\s\S]*SCHOOL_DB_URLS[\s\S]*DEPLOY_SSH_KNOWN_HOSTS/
    );
  });

  it("rejects out-of-range numbers", () => {
    expect(() => loadWorkerEnv({ ...good, POLL_MS: "10" })).toThrow(/POLL_MS/);
    expect(() => loadWorkerEnv({ ...good, STALE_MINUTES: "1" })).toThrow(/STALE_MINUTES/);
  });
});

describe("sslOptions", () => {
  it("uses no TLS for a local database", () => {
    expect(sslOptions("postgres://u:p@127.0.0.1:5432/db")).toBeUndefined();
    expect(sslOptions("postgres://u:p@localhost/db")).toBeUndefined();
  });
  it("uses TLS without verification for a remote one when no CA is given", () => {
    expect(sslOptions(URL_G)).toEqual({ rejectUnauthorized: false });
  });
});
