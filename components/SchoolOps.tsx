import { applySettingsAction, recordDrillAction } from "@/app/schools/actions";

type Drill = {
  id: string;
  drilled_at: string;
  ok: boolean;
  seconds: number;
  notes: string | null;
  recorded_by: string;
};
type Backup = { id: string; started_at: string; size_bytes: number | null };

const input = "w-full rounded border border-slate-300 px-2 py-1";
const when = (iso: string) => iso.slice(0, 16).replace("T", " ") + " UTC";
const mins = (s: number) => (s < 90 ? `${s} s` : `${Math.round(s / 6) / 10} min`);

// Owner-only controls on an active school's page: apply its container settings
// (key rotation), and record a restore drill. Neither runs anything here: the
// first queues a worker job, the second only records what a person did on their
// own machine, where the offline backup key is.
export function SchoolOps({
  school,
  drills,
  backups,
}: {
  school: { id: string; slug: string; status: string };
  drills: Drill[];
  backups: Backup[];
}) {
  return (
    <div className="space-y-6">
      {school.status === "active" && (
        <div className="space-y-2">
          <h3 className="text-sm font-medium">Apply settings (key rotation)</h3>
          <p className="text-xs text-slate-500">
            Restarts the school&apos;s container with the settings the worker holds for it (
            <code>SCHOOL_APP_ENVS</code>). Put the new keys there first and restart the worker,
            apply, and revoke the old keys only after this reports success. If the school is not
            healthy on the new settings, the server puts the old ones back. Steps:{" "}
            <code>docs/key-rotation.md</code>.
          </p>
          <form action={applySettingsAction} className="flex flex-wrap items-center gap-2 text-sm">
            <input type="hidden" name="schoolId" value={school.id} />
            <input
              name="confirm"
              required
              autoComplete="off"
              placeholder={`type ${school.slug}`}
              className="rounded border border-slate-300 px-2 py-1"
            />
            <button className="rounded border border-amber-400 px-3 py-1 hover:bg-amber-50">
              Apply settings
            </button>
          </form>
        </div>
      )}

      <div className="space-y-2">
        <h3 className="text-sm font-medium">Restore drills</h3>
        <p className="text-xs text-slate-500">
          Restore a backup into a scratch database with <code>scripts/restore-drill.sh</code> on
          your own machine (it needs the offline key), then record the result here.
        </p>
        {drills.length === 0 ? (
          <p className="text-sm text-slate-600">
            No drill recorded. A backup nobody has restored is a hope, not a backup.
          </p>
        ) : (
          <ul className="divide-y divide-slate-100 rounded border border-slate-200 bg-white text-sm">
            {drills.map((d) => (
              <li key={d.id} className="px-3 py-2">
                <span className={d.ok ? "text-green-800" : "text-red-700"}>
                  {d.ok ? "passed" : "failed"}
                </span>{" "}
                {when(d.drilled_at)}, took {mins(d.seconds)}, by {d.recorded_by}
                {d.notes && <span className="block text-xs text-slate-500">{d.notes}</span>}
              </li>
            ))}
          </ul>
        )}
        <form action={recordDrillAction} className="grid gap-3 text-sm sm:grid-cols-2">
          <input type="hidden" name="schoolId" value={school.id} />
          <label className="block">
            <span className="mb-1 block text-slate-700">Backup restored</span>
            <select name="backupId" className={input} defaultValue="">
              <option value="">— none (the drill failed before one was chosen) —</option>
              {backups.map((b) => (
                <option key={b.id} value={b.id}>
                  {when(b.started_at)}
                  {b.size_bytes ? `, ${Math.round(b.size_bytes / 1024)} KB` : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-slate-700">Result</span>
            <select name="ok" className={input} defaultValue="true">
              <option value="true">Passed</option>
              <option value="false">Failed</option>
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-slate-700">Minutes it took</span>
            <input
              name="minutes"
              type="number"
              min={0}
              max={1440}
              step="0.5"
              required
              className={input}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-slate-700">Notes</span>
            <input name="notes" maxLength={1000} className={input} />
          </label>
          <div className="sm:col-span-2">
            <button className="rounded border border-slate-300 px-3 py-1 hover:bg-slate-100">
              Record drill
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
