import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const GOOD = {
  SUPABASE_URL: "https://abc.supabase.co",
  SUPABASE_ANON_KEY: "anon",
  SUPABASE_SERVICE_ROLE_KEY: "service",
};

describe("lib/env", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    vi.resetModules();
    Object.assign(process.env, GOOD);
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it("loads a complete configuration", async () => {
    const { env } = await import("@/lib/env");
    expect(env.SUPABASE_URL).toBe(GOOD.SUPABASE_URL);
  });

  it("takes the proof bucket settings all together or not at all", async () => {
    const all = {
      PROOF_R2_ENDPOINT: "https://abc.r2.cloudflarestorage.com",
      PROOF_R2_BUCKET: "school-proofs",
      PROOF_R2_ACCESS_KEY_ID: "AKIA12345678",
      PROOF_R2_SECRET_ACCESS_KEY: "0123456789abcdef0123",
    };
    Object.assign(process.env, all);
    const { env } = await import("@/lib/env");
    expect(env.PROOF_R2_BUCKET).toBe("school-proofs");

    vi.resetModules();
    delete process.env.PROOF_R2_SECRET_ACCESS_KEY;
    await expect(import("@/lib/env")).rejects.toThrow(
      /PROOF_R2_SECRET_ACCESS_KEY: Set all four PROOF_R2_\* values, or none/
    );

    vi.resetModules();
    for (const k of Object.keys(all)) delete process.env[k];
    await expect(import("@/lib/env")).resolves.toBeDefined();
  });

  it("names every missing or invalid value in one error", async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    process.env.SUPABASE_URL = "not-a-url";
    await expect(import("@/lib/env")).rejects.toThrow(
      /SUPABASE_URL.*SUPABASE_SERVICE_ROLE_KEY|SUPABASE_SERVICE_ROLE_KEY.*SUPABASE_URL/s
    );
  });
});
