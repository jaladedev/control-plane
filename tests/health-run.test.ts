import { describe, expect, it, vi } from "vitest";
import { runHealthChecks } from "@/lib/health-run";

type Row = { id: string; slug: string; hostnames: string[]; consecutive_failures: number };

function fakeAdmin(schools: Row[]) {
  const inserted: Record<string, unknown>[] = [];
  const updates: { id: string; values: Record<string, unknown> }[] = [];
  const admin = {
    from: () => ({
      select: () => ({ neq: async () => ({ data: schools, error: null }) }),
      insert: async (values: Record<string, unknown>) => {
        inserted.push(values);
        return { error: null };
      },
      update: (values: Record<string, unknown>) => ({
        eq: async (_column: string, id: string) => {
          updates.push({ id, values });
          return { error: null };
        },
      }),
    }),
    rpc: vi.fn().mockResolvedValue({ data: 4, error: null }),
  };
  return { admin: admin as never, inserted, updates, rpc: admin.rpc };
}

const ok = { ok: true, httpStatus: 200, latencyMs: 90, version: "abc1234", error: null };
const bad = {
  ok: false,
  httpStatus: 503,
  latencyMs: 30,
  version: null,
  error: "R2_BUCKET missing",
};

describe("runHealthChecks", () => {
  it("probes the first hostname, records each result and updates the school", async () => {
    const { admin, inserted, updates } = fakeAdmin([
      {
        id: "s1",
        slug: "green",
        hostnames: ["green.example.com", "alt.example.com"],
        consecutive_failures: 3,
      },
      { id: "s2", slug: "blue", hostnames: ["blue.example.com"], consecutive_failures: 0 },
    ]);
    const probe = vi.fn(async (host: string) => (host.startsWith("green") ? ok : bad));

    const summary = await runHealthChecks(admin, probe);

    expect(probe.mock.calls.map((c) => c[0]).sort()).toEqual([
      "blue.example.com",
      "green.example.com",
    ]);
    expect(summary).toEqual({ checked: 2, up: 1, failing: 1, pruned: 4 });
    expect(inserted).toHaveLength(2);

    const green = updates.find((u) => u.id === "s1")!.values;
    expect(green).toMatchObject({
      health_status: "up",
      consecutive_failures: 0,
      image_tag: "abc1234",
    });
    expect(green.last_ok_at).toBeTruthy();

    const blue = updates.find((u) => u.id === "s2")!.values;
    expect(blue).toMatchObject({
      health_status: "degraded",
      consecutive_failures: 1,
      last_error: "R2_BUCKET missing",
    });
    expect(blue).not.toHaveProperty("last_ok_at");
    expect(blue).not.toHaveProperty("image_tag");
  });

  it("marks a school down on the second failure in a row", async () => {
    const { admin, updates } = fakeAdmin([
      { id: "s1", slug: "green", hostnames: ["green.example.com"], consecutive_failures: 1 },
    ]);
    await runHealthChecks(admin, async () => bad);
    expect(updates[0].values).toMatchObject({ health_status: "down", consecutive_failures: 2 });
  });

  it("skips schools with no hostname", async () => {
    const { admin, inserted } = fakeAdmin([
      { id: "s1", slug: "green", hostnames: [], consecutive_failures: 0 },
    ]);
    const probe = vi.fn();
    const summary = await runHealthChecks(admin, probe);
    expect(probe).not.toHaveBeenCalled();
    expect(inserted).toHaveLength(0);
    expect(summary.checked).toBe(0);
  });
});
