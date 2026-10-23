import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  env: { CRON_SECRET: "s".repeat(40) as string | undefined },
  run: vi.fn(),
}));

vi.mock("@/lib/env", () => ({ env: mocks.env }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => ({})) }));
vi.mock("@/lib/health-run", () => ({ runHealthChecks: mocks.run }));

import { POST } from "@/app/api/cron/health/route";

const call = (authorization?: string) =>
  POST(
    new Request("https://cp.example.com/api/cron/health", {
      method: "POST",
      headers: authorization ? { authorization } : {},
    }) as never
  );

beforeEach(() => {
  mocks.run.mockReset();
  mocks.env.CRON_SECRET = "s".repeat(40);
});

describe("POST /api/cron/health", () => {
  it("runs the checks with the right bearer secret", async () => {
    mocks.run.mockResolvedValue({ checked: 2, up: 2, failing: 0, pruned: 0 });
    const res = await call(`Bearer ${"s".repeat(40)}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, checked: 2, up: 2, failing: 0, pruned: 0 });
  });

  it.each([undefined, "", "Bearer ", "Bearer wrong", `Basic ${"s".repeat(40)}`, "s".repeat(40)])(
    "refuses %j without running anything",
    async (header) => {
      const res = await call(header);
      expect(res.status).toBe(401);
      expect(mocks.run).not.toHaveBeenCalled();
    }
  );

  it("refuses everything when CRON_SECRET is not set", async () => {
    mocks.env.CRON_SECRET = undefined;
    const res = await call("Bearer anything");
    expect(res.status).toBe(503);
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("returns 500 with the reason when the run fails", async () => {
    mocks.run.mockRejectedValue(new Error("Could not load schools: boom"));
    const res = await call(`Bearer ${"s".repeat(40)}`);
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/boom/);
  });
});
