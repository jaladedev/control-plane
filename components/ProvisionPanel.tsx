import { defaultValidUntil, LICENSE_DEFAULTS } from "@/lib/licensing";
import { provisionSchoolAction } from "@/app/schools/actions";
import { AutoRefresh } from "@/components/AutoRefresh";
import { PROVISION_STEPS } from "@/lib/provision/steps";

type Step = { step: string; status: string; detail: string | null };
type Job = { status: string; error: string | null; created_at: string } | null;
type School = {
  id: string;
  slug: string;
  hostnames: string[] | null;
  license_version: number;
  license_session: string | null;
  first_admin_name: string | null;
  first_admin_email: string | null;
};

const LABELS: Record<string, string> = {
  database: "Database: apply every migration",
  storage: "Storage: check the R2 bucket and key",
  container: "Container, proxy route and domain",
  license: "Licence: deliver to the school",
  admin: "First admin: create the login (password sent to you on Telegram)",
  health: "First health check on the public address",
  activate: "Go live",
};
const MARK: Record<string, string> = {
  pending: "○",
  running: "…",
  succeeded: "✓",
  failed: "✗",
};
const input = "w-full rounded border border-slate-300 px-2 py-1";

// The new-school wizard, shown to the owner while a school is still
// "provisioning". It never runs anything itself: pressing the button queues a job
// and the worker reports each step here as it goes.
export function ProvisionPanel({
  school,
  steps,
  job,
}: {
  school: School;
  steps: Step[];
  job: Job;
}) {
  const byStep = new Map(steps.map((s) => [s.step, s]));
  const busy = job?.status === "queued" || job?.status === "running";
  const started = steps.length > 0;
  const hasLicense = school.license_version > 0;
  const hasAdmin = Boolean(school.first_admin_email);

  return (
    <div className="space-y-4">
      {busy && <AutoRefresh />}

      {started && (
        <ol className="divide-y divide-slate-100 rounded border border-slate-200 bg-white text-sm">
          {PROVISION_STEPS.map((name) => {
            const s = byStep.get(name);
            const status = s?.status ?? "pending";
            return (
              <li key={name} className="flex gap-3 px-3 py-2">
                <span
                  aria-label={status}
                  className={status === "failed" ? "text-red-700" : "text-slate-700"}
                >
                  {MARK[status]}
                </span>
                <div>
                  <p>{LABELS[name]}</p>
                  {s?.detail && (
                    <p
                      className={`text-xs ${status === "failed" ? "text-red-700" : "text-slate-500"}`}
                    >
                      {s.detail}
                    </p>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}
      {job?.status === "failed" && job.error && (
        <p role="alert" className="rounded bg-red-50 p-3 text-sm text-red-800">
          {job.error}
        </p>
      )}

      <div className="rounded border border-slate-200 bg-white p-3 text-sm text-slate-700">
        <p className="font-medium">Before you press the button</p>
        <ul className="mt-1 list-disc space-y-1 pl-5 text-xs">
          <li>
            The worker&apos;s environment has this school under <code>SCHOOL_DB_URLS</code> (an
            empty Supabase project) and <code>SCHOOL_APP_ENVS</code> (its container settings).
          </li>
          <li>
            The DNS record for {school.hostnames?.join(", ") || "its hostname"} points at the
            server.
          </li>
          <li>A release is registered; the school starts on the newest one.</li>
          <li>
            Telegram is set up on the worker: the first admin&apos;s password is sent there and
            stored nowhere else.
          </li>
        </ul>
      </div>

      {!busy && (
        <form action={provisionSchoolAction} className="grid gap-4 sm:grid-cols-2">
          <input type="hidden" name="schoolId" value={school.id} />
          {!hasAdmin ? (
            <>
              <label className="block text-sm">
                <span className="mb-1 block text-slate-700">First admin&apos;s name</span>
                <input name="admin_name" required className={input} />
              </label>
              <label className="block text-sm">
                <span className="mb-1 block text-slate-700">First admin&apos;s email</span>
                <input name="admin_email" type="email" required className={input} />
                <span className="mt-1 block text-xs text-slate-500">
                  Their temporary password is sent to you on Telegram, not by email.
                </span>
              </label>
            </>
          ) : (
            <p className="text-xs text-slate-500 sm:col-span-2">
              First admin: {school.first_admin_name} ({school.first_admin_email}).
            </p>
          )}
          {!hasLicense ? (
            <>
              <label className="block text-sm">
                <span className="mb-1 block text-slate-700">First licence</span>
                <select name="kind" defaultValue="trial" className={input}>
                  <option value="trial">Trial</option>
                  <option value="paid">Paid</option>
                </select>
              </label>
              <label className="block text-sm">
                <span className="mb-1 block text-slate-700">Academic session</span>
                <input name="session" required placeholder="2026/2027" className={input} />
              </label>
              <label className="block text-sm">
                <span className="mb-1 block text-slate-700">Valid until (end of day, UTC)</span>
                <input
                  name="valid_until"
                  type="date"
                  required
                  defaultValue={defaultValidUntil()}
                  className={input}
                />
              </label>
              <label className="block text-sm">
                <span className="mb-1 block text-slate-700">Grace days</span>
                <input
                  name="grace_days"
                  type="number"
                  min={0}
                  max={90}
                  required
                  defaultValue={LICENSE_DEFAULTS.graceDays}
                  className={input}
                />
              </label>
            </>
          ) : (
            <p className="text-xs text-slate-500 sm:col-span-2">
              Licence saved (session {school.license_session}). It is delivered to the school when
              its database exists.
            </p>
          )}
          <div className="sm:col-span-2">
            <button className="rounded bg-slate-900 px-4 py-2 text-sm text-white hover:bg-slate-700">
              {started ? "Resume provisioning" : "Start provisioning"}
            </button>
            {started && (
              <p className="mt-1 text-xs text-slate-500">
                Steps that already succeeded are not repeated.
              </p>
            )}
          </div>
        </form>
      )}
    </div>
  );
}
