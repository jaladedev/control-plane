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

  it("names every missing or invalid value in one error", async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    process.env.SUPABASE_URL = "not-a-url";
    await expect(import("@/lib/env")).rejects.toThrow(
      /SUPABASE_URL.*SUPABASE_SERVICE_ROLE_KEY|SUPABASE_SERVICE_ROLE_KEY.*SUPABASE_URL/s
    );
  });
});
