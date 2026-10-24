import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePage } from "@/lib/auth/guards";
import { createClient } from "@/lib/supabase/server";
import { SCHOOL_STATUSES, licenseState } from "@/lib/schools";
import type { HealthStatus } from "@/lib/health";
import { SchoolForm } from "@/components/SchoolForm";
import { LicenseForm } from "@/components/LicenseForm";
import { SupportLink } from "@/components/SupportLink";
import { HealthBadge, LicenseBadge, ago } from "@/components/badges";
import { setStatusAction, updateSchoolAction } from "@/app/schools/actions";

const OK: Record<string, string> = {
  created: "School registered. Health checks start with the next scheduled run.",
  saved: "Changes saved.",
  status: "Status updated.",
  licensed: "Licence saved and delivered to the school.",
  pushed: "Licence delivered to the school.",
  revoked: "Licence revoked. The school is now read-only.",
};

const fmt = (iso: string | null) => (iso ? iso.slice(0, 16).replace("T", " ") + " UTC" : "—");

export default async function SchoolPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  const actor = await requirePage();
  const { id } = await params;
  const { ok, error } = await searchParams;

  const supabase = await createClient();
  // A malformed id makes Postgres reject the uuid; either way it is "not found".
  const { data: school } = await supabase.from("schools").select("*").eq("id", id).maybeSingle();
  if (!school) notFound();

  const { data: checks } = await supabase
    .from("health_checks")
    .select("id, at, ok, http_status, latency_ms, version, error")
    .eq("school_id", id)
    .order("at", { ascending: false })
    .limit(20);

  const { data: runs } = await supabase
    .from("migration_runs")
    .select("id, status, started_at, finished_at, error, migrations(name)")
    .eq("school_id", id)
    .order("started_at", { ascending: false })
    .limit(10);

  const isOwner = actor.role === "owner";
  const canLicense = isOwner || actor.role === "finance";
  const canSupport = (isOwner || actor.role === "support") && school.status !== "archived";

  return (
    <div className="space-y-8">
      <div>
        <Link href="/" className="text-sm text-slate-500 hover:underline">
          ← Schools
        </Link>
        <h1 className="mt-1 text-xl font-semibold">
          {school.name} <span className="font-mono text-sm text-slate-500">{school.slug}</span>
        </h1>
      </div>
      {ok && OK[ok] && <p className="rounded bg-green-50 p-3 text-sm text-green-800">{OK[ok]}</p>}
      {error && (
        <p role="alert" className="rounded bg-red-50 p-3 text-sm text-red-800">
          {error}
        </p>
      )}

      <section className="grid gap-4 rounded border border-slate-200 bg-white p-4 text-sm sm:grid-cols-3">
        <div>
          <h2 className="mb-1 text-slate-500">Health</h2>
          <HealthBadge status={school.health_status as HealthStatus} />
          <p className="mt-2 text-xs text-slate-500">
            Checked {ago(school.last_checked_at)}; last healthy {ago(school.last_ok_at)}
          </p>
          {school.last_error && <p className="mt-1 text-xs text-red-700">{school.last_error}</p>}
        </div>
        <div>
          <h2 className="mb-1 text-slate-500">Running version</h2>
          <p className="font-mono">{school.image_tag ?? "—"}</p>
          <p className="mt-2 text-xs text-slate-500">Reported by the school&apos;s /api/health.</p>
        </div>
        <div>
          <h2 className="mb-1 text-slate-500">Licence</h2>
          <LicenseBadge state={licenseState(school)} />
          {school.license_is_trial && <span className="ml-2 text-xs text-slate-500">trial</span>}
          <p className="mt-2 text-xs text-slate-500">
            Valid until {fmt(school.license_valid_until)}; grace until{" "}
            {fmt(school.license_grace_until)}. Version {school.license_version}.
          </p>
          <p className="mt-1 text-xs text-slate-500">
            {school.license_version === 0
              ? "No licence set yet."
              : school.license_version > school.license_pushed_version
                ? "Saved but not yet delivered to the school."
                : `Delivered to the school ${ago(school.license_pushed_at)}.`}
          </p>
        </div>
      </section>

      {canLicense && (
        <section className="space-y-3">
          <h2 className="font-semibold">Licence</h2>
          <LicenseForm school={school} isOwner={isOwner} />
        </section>
      )}

      {canSupport && (
        <section className="space-y-3">
          <h2 className="font-semibold">Support session</h2>
          <SupportLink schoolId={school.id} />
        </section>
      )}

      {isOwner ? (
        <>
          <section className="space-y-3">
            <h2 className="font-semibold">Details</h2>
            <SchoolForm
              action={updateSchoolAction}
              schoolId={school.id}
              defaults={school}
              submitLabel="Save changes"
            />
          </section>
          <section className="space-y-3">
            <h2 className="font-semibold">Status</h2>
            <form action={setStatusAction} className="flex items-center gap-2 text-sm">
              <input type="hidden" name="schoolId" value={school.id} />
              <select
                name="status"
                defaultValue={school.status}
                className="rounded border border-slate-300 px-2 py-1"
              >
                {SCHOOL_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
              <button className="rounded border border-slate-300 px-3 py-1 hover:bg-slate-100">
                Change
              </button>
            </form>
            <p className="text-xs text-slate-500">
              Status is a record here. It does not stop or restrict the school; use Revoke licence
              for that. Archived schools are no longer health-checked.
            </p>
          </section>
        </>
      ) : (
        <section className="rounded border border-slate-200 bg-white p-4 text-sm">
          <dl className="grid gap-2 sm:grid-cols-2">
            <div>
              <dt className="text-slate-500">Status</dt>
              <dd>{school.status}</dd>
            </div>
            <div>
              <dt className="text-slate-500">Hostnames</dt>
              <dd>{school.hostnames?.join(", ") || "—"}</dd>
            </div>
            <div>
              <dt className="text-slate-500">Plan</dt>
              <dd>{school.hosting_plan}</dd>
            </div>
            <div>
              <dt className="text-slate-500">Included students</dt>
              <dd>{school.included_students}</dd>
            </div>
          </dl>
        </section>
      )}

      <section className="space-y-3">
        <h2 className="font-semibold">Migration history</h2>
        <p className="text-xs text-slate-500">
          Database version:{" "}
          <span className="font-mono">{school.schema_version ?? "not read yet"}</span>. Group:{" "}
          {school.rollout_group}.
        </p>
        {!runs?.length ? (
          <p className="text-sm text-slate-600">
            No migrations have been run through the control plane for this school.
          </p>
        ) : (
          <div className="overflow-x-auto rounded border border-slate-200 bg-white">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-slate-600">
                <tr>
                  <th className="px-3 py-2">Migration</th>
                  <th className="px-3 py-2">Result</th>
                  <th className="px-3 py-2">When</th>
                  <th className="px-3 py-2">Error</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id} className="border-b border-slate-100 last:border-0">
                    <td className="px-3 py-2 font-mono text-xs">
                      {(r as unknown as { migrations: { name: string } | null }).migrations?.name ??
                        "?"}
                    </td>
                    <td className="px-3 py-2">{r.status}</td>
                    <td className="px-3 py-2">{fmt(r.finished_at ?? r.started_at)}</td>
                    <td className="px-3 py-2 text-xs text-red-700">{r.error ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="font-semibold">Recent health checks</h2>
        {!checks?.length ? (
          <p className="text-sm text-slate-600">No checks yet.</p>
        ) : (
          <div className="overflow-x-auto rounded border border-slate-200 bg-white">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-slate-600">
                <tr>
                  <th className="px-3 py-2">When</th>
                  <th className="px-3 py-2">Result</th>
                  <th className="px-3 py-2">HTTP</th>
                  <th className="px-3 py-2">Latency</th>
                  <th className="px-3 py-2">Version</th>
                  <th className="px-3 py-2">Error</th>
                </tr>
              </thead>
              <tbody>
                {checks.map((c) => (
                  <tr key={c.id} className="border-b border-slate-100 last:border-0">
                    <td className="px-3 py-2">{fmt(c.at)}</td>
                    <td className="px-3 py-2">{c.ok ? "ok" : "failed"}</td>
                    <td className="px-3 py-2">{c.http_status ?? "—"}</td>
                    <td className="px-3 py-2">
                      {c.latency_ms != null ? `${c.latency_ms} ms` : "—"}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs">{c.version ?? "—"}</td>
                    <td className="px-3 py-2 text-xs text-red-700">{c.error ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
