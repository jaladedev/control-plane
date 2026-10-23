import type { SupabaseClient } from "@supabase/supabase-js";
import { nextHealth, probeSchool, type ProbeResult } from "@/lib/health";

// One health run: probe every school that has a hostname, record the results,
// and prune old history. Used by the cron route. Not an actor-initiated write,
// so it does not go through withAudit (that would put an audit row in every
// five minutes); it only ever writes health data.

type SchoolRow = {
  id: string;
  slug: string;
  hostnames: string[];
  consecutive_failures: number;
};

export type RunSummary = { checked: number; up: number; failing: number; pruned: number };

const CONCURRENCY = 8;

export async function runHealthChecks(
  admin: SupabaseClient,
  probe: (hostname: string, expectedSlug?: string) => Promise<ProbeResult> = (h, slug) =>
    probeSchool(h, { expectedSlug: slug })
): Promise<RunSummary> {
  const { data, error } = await admin
    .from("schools")
    .select("id, slug, hostnames, consecutive_failures")
    .neq("status", "archived");
  if (error) throw new Error(`Could not load schools: ${error.message}`);

  const schools = ((data ?? []) as SchoolRow[]).filter((s) => s.hostnames?.length > 0);
  const summary: RunSummary = { checked: 0, up: 0, failing: 0, pruned: 0 };

  for (let i = 0; i < schools.length; i += CONCURRENCY) {
    const batch = schools.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map(async (school) => {
        const result = await probe(school.hostnames[0], school.slug);
        const { status, failures } = nextHealth(school.consecutive_failures, result.ok);
        const now = new Date().toISOString();

        const { error: insertError } = await admin.from("health_checks").insert({
          school_id: school.id,
          at: now,
          ok: result.ok,
          http_status: result.httpStatus,
          latency_ms: result.latencyMs,
          version: result.version,
          error: result.error,
        });
        if (insertError) throw new Error(`Could not record a check: ${insertError.message}`);

        const update: Record<string, unknown> = {
          health_status: status,
          last_checked_at: now,
          consecutive_failures: failures,
          last_latency_ms: result.latencyMs,
          last_error: result.error,
        };
        if (result.ok) {
          update.last_ok_at = now;
          if (result.version) update.image_tag = result.version;
        }
        const { error: updateError } = await admin
          .from("schools")
          .update(update)
          .eq("id", school.id);
        if (updateError) throw new Error(`Could not update ${school.slug}: ${updateError.message}`);

        summary.checked += 1;
        if (result.ok) summary.up += 1;
        else summary.failing += 1;
      })
    );
  }

  const { data: pruned } = await admin.rpc("prune_health_checks", { p_keep_days: 30 });
  summary.pruned = typeof pruned === "number" ? pruned : 0;
  return summary;
}
