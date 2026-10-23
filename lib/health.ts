import { normalizeHostname } from "@/lib/schools";

// Probing a school's /api/health, and turning results into a status. Pure
// apart from the fetch (injectable for tests).

export type HealthStatus = "unknown" | "up" | "degraded" | "down";

export type ProbeResult = {
  ok: boolean;
  httpStatus: number | null;
  latencyMs: number;
  version: string | null;
  error: string | null;
};

const MAX_BODY_BYTES = 64 * 1024;

async function readLimited(res: Response): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < MAX_BODY_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  await reader.cancel().catch(() => {});
  return new TextDecoder().decode(Buffer.concat(chunks)).slice(0, MAX_BODY_BYTES);
}

const clip = (text: string, n: number) => (text.length > n ? `${text.slice(0, n)}…` : text);

/**
 * GET https://<hostname>/api/health. Healthy means HTTP 200 with {"ok": true}.
 * Never throws. Redirects are not followed, so a hostname cannot bounce the
 * check to somewhere else.
 */
export async function probeSchool(
  hostname: string,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}
): Promise<ProbeResult> {
  const started = Date.now();
  const done = (r: Omit<ProbeResult, "latencyMs">): ProbeResult => ({
    ...r,
    latencyMs: Date.now() - started,
  });

  let host: string;
  try {
    host = normalizeHostname(hostname);
  } catch (e) {
    return done({
      ok: false,
      httpStatus: null,
      version: null,
      error: e instanceof Error ? e.message : "Invalid hostname.",
    });
  }

  try {
    const res = await (opts.fetchImpl ?? fetch)(`https://${host}/api/health`, {
      method: "GET",
      redirect: "manual",
      cache: "no-store",
      headers: { accept: "application/json", "user-agent": "control-plane-health/1" },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 8000),
    });
    const text = await readLimited(res);
    let body: { ok?: unknown; version?: unknown; error?: unknown } | null = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    const version = typeof body?.version === "string" ? clip(body.version, 64) : null;

    if (res.status >= 300 && res.status < 400) {
      return done({
        ok: false,
        httpStatus: res.status,
        version,
        error: `Redirected (HTTP ${res.status}).`,
      });
    }
    if (res.status === 200 && body?.ok === true) {
      return done({ ok: true, httpStatus: 200, version, error: null });
    }
    const detail =
      typeof body?.error === "string" && body.error
        ? clip(body.error, 300)
        : res.status === 200
          ? "Health response did not say ok."
          : `HTTP ${res.status}.`;
    return done({ ok: false, httpStatus: res.status, version, error: detail });
  } catch (e) {
    const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    const cause = e instanceof Error ? (e.cause as { code?: string } | undefined)?.code : undefined;
    return done({
      ok: false,
      httpStatus: null,
      version: null,
      error: timedOut ? "Timed out." : `Could not connect${cause ? ` (${cause})` : ""}.`,
    });
  }
}

/** One failure is "degraded"; two in a row is "down". A success resets. */
export function nextHealth(
  previousFailures: number,
  ok: boolean
): { status: HealthStatus; failures: number } {
  if (ok) return { status: "up", failures: 0 };
  const failures = previousFailures + 1;
  return { status: failures >= 2 ? "down" : "degraded", failures };
}
