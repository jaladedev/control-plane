import { requirePage } from "@/lib/auth/guards";
import { createClient } from "@/lib/supabase/server";
import { RolloutPanel } from "@/components/RolloutPanel";
import { StatusBadge, ago } from "@/components/badges";
import {
  appState,
  pendingCount,
  planPreview,
  stalledQueueSeconds,
  type SchoolInfo,
} from "@/lib/rollout-view";
import { createRolloutAction, scanAction } from "@/app/migrations/actions";

const OK: Record<string, string> = {
  created: "Rollout planned. Release the test school to begin.",
  released: "Released. The worker will pick it up in a moment.",
  retried: "Step queued again. The rollout is running.",
  cancelled: "Rollout cancelled.",
  scanning: "Asked the worker to re-read every school's migrations.",
};

const short = (tag: string | null | undefined) => (tag ? tag.slice(0, 10) : "—");

// Releases and migrations: roll a release across the schools in canary order,
// see each school's database and app version, and watch results as they land.
export default async function MigrationsPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  const actor = await requirePage();
  const { ok, error } = await searchParams;
  const isOwner = actor.role === "owner";
  const supabase = await createClient();

  const [releasesRes, migrationsRes, schoolsRes, activeRes, historyRes, queuedRes] =
    await Promise.all([
      supabase
        .from("releases")
        .select("id, seq, image_tag, notes, created_at")
        .order("seq", { ascending: false })
        .limit(15),
      supabase
        .from("migrations")
        .select("version, name, kind, release_id")
        .order("version", { ascending: false }),
      supabase
        .from("schools")
        .select(
          "id, slug, name, status, rollout_group, hostnames, supabase_project_ref, schema_version, image_tag, credentials_status"
        )
        .neq("status", "archived")
        .order("slug"),
      supabase.from("rollouts").select("*").in("status", ["running", "halted"]).maybeSingle(),
      supabase
        .from("rollouts")
        .select("id, image_tag, status, created_at, finished_at")
        .not("status", "in", "(running,halted)")
        .order("created_at", { ascending: false })
        .limit(5),
      supabase.from("jobs").select("created_at, run_after").eq("status", "queued"),
    ]);

  const releases = releasesRes.data ?? [];
  const migrations = migrationsRes.data ?? [];
  const schools = schoolsRes.data ?? [];
  const active = activeRes.data;
  const history = historyRes.data ?? [];

  const steps = active
    ? ((
        await supabase
          .from("rollout_steps")
          .select(
            "id, position, stage, batch_no, status, attempt, error, result, finished_at, schools(slug, name)"
          )
          .eq("rollout_id", active.id)
          .order("position")
      ).data ?? [])
    : [];

  const latestSeq = releases[0]?.seq ?? null;
  const seqByTag = new Map(releases.map((r) => [r.image_tag as string, Number(r.seq)]));
  const versions = migrations.map((m) => m.version as string);
  const stalled = stalledQueueSeconds(queuedRes.data ?? []);
  const preview = planPreview(schools as SchoolInfo[]);

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Migrations and releases</h1>
        {isOwner && (
          <form action={scanAction}>
            <button className="rounded border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100">
              Refresh versions
            </button>
          </form>
        )}
      </div>

      {ok && OK[ok] && <p className="rounded bg-green-50 p-3 text-sm text-green-800">{OK[ok]}</p>}
      {error && (
        <p role="alert" className="rounded bg-red-50 p-3 text-sm text-red-800">
          {error}
        </p>
      )}
      {stalled !== null && (
        <p role="alert" className="rounded bg-amber-50 p-3 text-sm text-amber-900">
          A job has been waiting {Math.round(stalled / 60)} minutes. Is the worker running? (
          <code>npm run worker</code>)
        </p>
      )}

      {active ? (
        <RolloutPanel rollout={active} steps={steps as never} isOwner={isOwner} />
      ) : (
        <section className="space-y-3 rounded border border-slate-200 bg-white p-4">
          <h2 className="font-semibold">Start a rollout</h2>
          {releases.length === 0 ? (
            <p className="text-sm text-slate-600">
              No release is registered. Register the first with{" "}
              <code>npm run register-release</code> (see the README).
            </p>
          ) : isOwner ? (
            <form action={createRolloutAction} className="flex flex-wrap items-end gap-4 text-sm">
              <label className="block">
                <span className="mb-1 block text-slate-700">Release</span>
                <select name="releaseId" className="rounded border border-slate-300 px-2 py-1">
                  {releases.map((r) => (
                    <option key={r.id} value={r.id}>
                      {short(r.image_tag)} · {ago(r.created_at)}
                      {r.notes ? ` · ${r.notes}` : ""}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-slate-700">Batch size</span>
                <input
                  name="batchSize"
                  type="number"
                  min={1}
                  max={50}
                  defaultValue={5}
                  className="w-20 rounded border border-slate-300 px-2 py-1"
                />
              </label>
              <label className="flex max-w-xs items-start gap-2 text-slate-700">
                <input type="checkbox" name="skipBackup" className="mt-1" />
                <span>
                  Skip the backup for schools whose pending migrations are all expand. A school with
                  a contract migration pending is always backed up.
                </span>
              </label>
              <button
                disabled={preview.included.test === 0}
                className="rounded bg-slate-900 px-4 py-1.5 text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-300"
              >
                Plan rollout
              </button>
            </form>
          ) : (
            <p className="text-sm text-slate-600">Only an owner can start a rollout.</p>
          )}
          <p className="text-sm text-slate-600">
            Would include {preview.included.test} test, {preview.included.pilot} pilot and{" "}
            {preview.included.standard} other school(s).
            {preview.included.test === 0 &&
              " Mark an active school as the test school first (on its page)."}
          </p>
          {preview.excluded.length > 0 && (
            <p className="text-xs text-slate-500">
              Left out: {preview.excluded.map((e) => `${e.slug} (${e.reason})`).join(", ")}.
            </p>
          )}
          {history.length > 0 && (
            <ul className="space-y-1 border-t border-slate-100 pt-3 text-sm">
              {history.map((h) => (
                <li key={h.id} className="flex items-center gap-2">
                  <StatusBadge status={h.status} />
                  <span className="font-mono text-xs">{short(h.image_tag)}</span>
                  <span className="text-xs text-slate-500">
                    {ago(h.finished_at ?? h.created_at)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <section className="space-y-3">
        <h2 className="font-semibold">Version matrix</h2>
        <div className="overflow-x-auto rounded border border-slate-200 bg-white">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-slate-600">
              <tr>
                <th className="px-3 py-2">School</th>
                <th className="px-3 py-2">Group</th>
                <th className="px-3 py-2">Database</th>
                <th className="px-3 py-2">Pending</th>
                <th className="px-3 py-2">App</th>
                <th className="px-3 py-2">Credentials</th>
              </tr>
            </thead>
            <tbody>
              {schools.length === 0 && (
                <tr>
                  <td className="px-3 py-3 text-slate-500" colSpan={6}>
                    No schools yet.
                  </td>
                </tr>
              )}
              {schools.map((s) => {
                const pending = pendingCount(s.schema_version, versions);
                const app = appState(s.image_tag, seqByTag, latestSeq);
                return (
                  <tr key={s.id} className="border-b border-slate-100 last:border-0">
                    <td className="px-3 py-2 font-medium">{s.name}</td>
                    <td className="px-3 py-2">{s.rollout_group}</td>
                    <td className="px-3 py-2 font-mono text-xs">
                      {s.schema_version ?? "not read yet"}
                    </td>
                    <td className="px-3 py-2">
                      {pending === null ? "—" : pending === 0 ? "up to date" : `${pending} pending`}
                    </td>
                    <td className="px-3 py-2">
                      <span className="font-mono text-xs">{short(s.image_tag)}</span>
                      {app.state === "behind" && (
                        <span className="ml-2 text-xs text-amber-700">
                          {app.by} release{app.by === 1 ? "" : "s"} behind
                        </span>
                      )}
                      {app.state === "unknown" && s.image_tag && (
                        <span className="ml-2 text-xs text-slate-500">
                          not a registered release
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2">{s.credentials_status}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-slate-500">
          Database versions are read from each school&apos;s own migration table by the worker
          (every 30 minutes, or when an owner asks for a refresh).
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="font-semibold">Registered releases and migrations</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <ul className="space-y-1 rounded border border-slate-200 bg-white p-3 text-sm">
            {releases.length === 0 && <li className="text-slate-500">No releases.</li>}
            {releases.map((r) => (
              <li key={r.id}>
                <span className="font-mono text-xs">{short(r.image_tag)}</span>{" "}
                <span className="text-xs text-slate-500">{ago(r.created_at)}</span>
                {r.notes && <span className="ml-1 text-xs">{r.notes}</span>}
              </li>
            ))}
          </ul>
          <ul className="max-h-64 space-y-1 overflow-y-auto rounded border border-slate-200 bg-white p-3 text-sm">
            {migrations.length === 0 && <li className="text-slate-500">No migrations.</li>}
            {migrations.slice(0, 40).map((m) => (
              <li key={m.version} className="flex items-center gap-2">
                <span className="font-mono text-xs">{m.name}</span>
                {m.kind === "contract" && (
                  <span className="rounded bg-amber-100 px-1.5 text-xs text-amber-800">
                    contract
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      </section>
    </div>
  );
}
