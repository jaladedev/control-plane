import Link from "next/link";
import { requirePage } from "@/lib/auth/guards";
import { createClient } from "@/lib/supabase/server";
import { licenseState } from "@/lib/schools";
import { isUnsynced } from "@/lib/licensing";
import type { HealthStatus } from "@/lib/health";
import { HealthBadge, LicenseBadge, ago } from "@/components/badges";

// The schools registry: status, health from the last probe, licence state
// (derived from the clock) and the running image version.
export default async function SchoolsPage() {
  const actor = await requirePage();
  const supabase = await createClient();
  const { data: schools, error } = await supabase
    .from("schools")
    .select(
      "id, slug, name, status, hostnames, hosting_plan, image_tag, health_status, last_checked_at, last_error, license_valid_until, license_grace_until, license_is_trial, license_version, license_pushed_version, included_students"
    )
    .order("name");

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold">Schools</h1>
        {actor.role === "owner" && (
          <Link
            href="/schools/new"
            className="rounded bg-slate-900 px-3 py-1.5 text-sm text-white hover:bg-slate-700"
          >
            Add school
          </Link>
        )}
      </div>
      {error && (
        <p className="mb-4 text-sm text-red-700">Could not load schools: {error.message}</p>
      )}
      {!schools?.length ? (
        <p className="rounded border border-dashed border-slate-300 bg-white p-6 text-sm text-slate-600">
          No schools yet.{" "}
          {actor.role === "owner"
            ? "Use Add school to register the first one."
            : "An owner can register one."}
        </p>
      ) : (
        <div className="overflow-x-auto rounded border border-slate-200 bg-white">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-slate-600">
              <tr>
                <th className="px-3 py-2">Name</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Health</th>
                <th className="px-3 py-2">Licence</th>
                <th className="px-3 py-2">Version</th>
                <th className="px-3 py-2">Hostname</th>
                <th className="px-3 py-2">Plan</th>
                <th className="px-3 py-2">Students</th>
              </tr>
            </thead>
            <tbody>
              {schools.map((s) => (
                <tr key={s.id} className="border-b border-slate-100 last:border-0">
                  <td className="px-3 py-2 font-medium">
                    <Link href={`/schools/${s.id}`} className="hover:underline">
                      {s.name}
                    </Link>
                  </td>
                  <td className="px-3 py-2">{s.status}</td>
                  <td className="px-3 py-2" title={s.last_error ?? undefined}>
                    <HealthBadge status={s.health_status as HealthStatus} />
                    <span className="ml-2 text-xs text-slate-500">{ago(s.last_checked_at)}</span>
                  </td>
                  <td className="px-3 py-2">
                    <LicenseBadge state={licenseState(s)} />
                    {s.license_is_trial && (
                      <span className="ml-2 text-xs text-slate-500">trial</span>
                    )}
                    {isUnsynced(s) && (
                      <span className="ml-2 text-xs font-medium text-amber-700">not delivered</span>
                    )}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">{s.image_tag ?? "—"}</td>
                  <td className="px-3 py-2">{s.hostnames?.[0] ?? "—"}</td>
                  <td className="px-3 py-2">{s.hosting_plan}</td>
                  <td className="px-3 py-2">{s.included_students}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
