import { describe, expect, it, vi } from "vitest";
import { nextHealth, probeSchool } from "@/lib/health";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

describe("probeSchool", () => {
  it("is healthy on HTTP 200 with ok true, and reports the version", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({ ok: true, version: "abc1234" }));
    const result = await probeSchool("School.Example.com", { fetchImpl });
    expect(result).toMatchObject({ ok: true, httpStatus: 200, version: "abc1234", error: null });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://school.example.com/api/health");
    expect(init.redirect).toBe("manual");
  });

  it("is unhealthy on 503 and passes on the school's own error text", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(json({ ok: false, version: "abc", error: "R2_BUCKET: Required" }, 503));
    const result = await probeSchool("school.example.com", { fetchImpl });
    expect(result).toMatchObject({ ok: false, httpStatus: 503, error: "R2_BUCKET: Required" });
  });

  it("is unhealthy on HTTP 200 without ok true (for example a proxy error page)", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response("<html>hello</html>", { status: 200 }));
    const result = await probeSchool("school.example.com", { fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/did not say ok/);
  });

  it("does not follow redirects", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(null, { status: 302, headers: { location: "https://evil.example" } })
      );
    const result = await probeSchool("school.example.com", { fetchImpl });
    expect(result).toMatchObject({ ok: false, httpStatus: 302 });
    expect(result.error).toMatch(/Redirected/);
  });

  it("reports a timeout", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("timed out"), { name: "TimeoutError" }));
    const result = await probeSchool("school.example.com", { fetchImpl });
    expect(result).toMatchObject({ ok: false, httpStatus: null, error: "Timed out." });
  });

  it("reports a connection failure with its code", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } })
      );
    const result = await probeSchool("school.example.com", { fetchImpl });
    expect(result.error).toBe("Could not connect (ENOTFOUND).");
  });

  it("never fetches a hostname that fails validation", async () => {
    const fetchImpl = vi.fn();
    for (const bad of ["localhost", "127.0.0.1", "a.com:8080", "10.0.0.1"]) {
      const result = await probeSchool(bad, { fetchImpl });
      expect(result.ok).toBe(false);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("clips an oversized version string", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({ ok: true, version: "v".repeat(500) }));
    const result = await probeSchool("school.example.com", { fetchImpl });
    expect(result.version!.length).toBeLessThanOrEqual(65);
  });
});

describe("nextHealth", () => {
  it("is up and resets on success", () => {
    expect(nextHealth(5, true)).toEqual({ status: "up", failures: 0 });
  });
  it("is degraded after one failure and down after two in a row", () => {
    expect(nextHealth(0, false)).toEqual({ status: "degraded", failures: 1 });
    expect(nextHealth(1, false)).toEqual({ status: "down", failures: 2 });
    expect(nextHealth(7, false)).toEqual({ status: "down", failures: 8 });
  });
});
