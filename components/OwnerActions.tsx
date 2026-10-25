import {
  createSchoolRolloutAction,
  registerReleaseAction,
  rollbackSchoolAction,
} from "@/app/migrations/actions";

type Release = { id: string; image_tag: string; created_at: string; notes: string | null };
type School = { id: string; slug: string; name: string; status: string };

const field = "rounded border border-slate-300 px-2 py-1 text-sm";
const label = "mb-1 block text-slate-700";
const short = (tag: string) => tag.slice(0, 10);

// Owner-only actions that sit beside the canary rollout: register a release from
// the dashboard, roll one school forward on its own, or take one school back. All
// three only queue work for the worker; the database refuses anything unsafe.
export function OwnerActions({
  releases,
  schools,
  rolloutActive,
}: {
  releases: Release[];
  schools: School[];
  rolloutActive: boolean;
}) {
  const live = schools.filter((s) => s.status === "active");
  return (
    <section className="space-y-6 rounded border border-slate-200 bg-white p-4">
      <h2 className="font-semibold">Other actions</h2>

      <form action={registerReleaseAction} className="space-y-2 text-sm">
        <h3 className="font-medium">Register a release</h3>
        <p className="text-slate-600">
          The worker reads that commit&apos;s migrations from GitHub and registers them. The image
          must already be built. The very first release is registered with{" "}
          <code>npm run register-release</code> (it needs <code>--baseline</code>).
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <label className="block">
            <span className={label}>Commit (40 characters)</span>
            <input
              name="tag"
              autoComplete="off"
              spellCheck={false}
              className={`${field} w-96 font-mono`}
            />
          </label>
          <label className="block">
            <span className={label}>Notes (optional)</span>
            <input name="notes" maxLength={500} className={`${field} w-56`} />
          </label>
          <button className="rounded bg-slate-900 px-4 py-1.5 text-white hover:bg-slate-700">
            Register
          </button>
        </div>
      </form>

      <form
        action={createSchoolRolloutAction}
        className="space-y-2 border-t border-slate-100 pt-4 text-sm"
      >
        <h3 className="font-medium">Roll out to one school</h3>
        <p className="text-slate-600">
          For an urgent fix or a single upgrade. No canary stages, so type the school&apos;s name to
          confirm. {rolloutActive && "Not available while another rollout is active."}
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <label className="block">
            <span className={label}>Release</span>
            <select name="releaseId" className={field} disabled={rolloutActive}>
              {releases.map((r) => (
                <option key={r.id} value={r.id}>
                  {short(r.image_tag)}
                  {r.notes ? ` · ${r.notes}` : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className={label}>School</span>
            <select name="schoolId" className={field} disabled={rolloutActive}>
              {live.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.slug}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className={label}>Type the school&apos;s name</span>
            <input
              name="confirm"
              autoComplete="off"
              className={`${field} w-48`}
              disabled={rolloutActive}
            />
          </label>
          <button
            disabled={rolloutActive || releases.length === 0 || live.length === 0}
            className="rounded bg-slate-900 px-4 py-1.5 text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-300"
          >
            Roll out
          </button>
        </div>
      </form>

      <form
        action={rollbackSchoolAction}
        className="space-y-2 border-t border-slate-100 pt-4 text-sm"
      >
        <h3 className="font-medium">Roll a school back</h3>
        <p className="text-slate-600">
          Takes the school back to the image it ran before. Database migrations are not undone. The
          worker first checks the server agrees about what is running, and tries once.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <label className="block">
            <span className={label}>School</span>
            <select name="schoolId" className={field}>
              {live.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.slug}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className={label}>Type the school&apos;s name</span>
            <input name="confirm" autoComplete="off" className={`${field} w-48`} />
          </label>
          <button
            disabled={live.length === 0}
            className="rounded border border-red-300 px-4 py-1.5 text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Roll back
          </button>
        </div>
      </form>
    </section>
  );
}
