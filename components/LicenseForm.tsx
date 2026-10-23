import { defaultValidUntil, LICENSE_DEFAULTS } from "@/lib/licensing";
import { pushLicenseAction, revokeLicenseAction, setLicenseAction } from "@/app/schools/actions";

type School = {
  id: string;
  license_version: number;
  license_pushed_version: number;
  license_session: string | null;
  license_is_trial: boolean;
  license_valid_until: string | null;
  license_grace_until: string | null;
  license_push_error: string | null;
  included_students: number;
  features: string[];
};

const input = "w-full rounded border border-slate-300 px-2 py-1";
const day = (iso: string | null) => (iso ? iso.slice(0, 10) : "");
const DAY_MS = 86_400_000;

// Set, resend and (owner only) revoke a school's licence. Prefilled from what
// is saved; a school with no licence gets the defaults (30-day trial, 14 days
// grace). Sets a new, higher version each time.
export function LicenseForm({ school, isOwner }: { school: School; isOwner: boolean }) {
  const hasLicense = school.license_version > 0;
  const grace =
    school.license_valid_until && school.license_grace_until
      ? Math.round(
          (new Date(school.license_grace_until).getTime() -
            new Date(school.license_valid_until).getTime()) /
            DAY_MS
        )
      : LICENSE_DEFAULTS.graceDays;
  const unsynced = school.license_version > school.license_pushed_version;

  return (
    <div className="space-y-4">
      {unsynced && (
        <div className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          <p>
            Version {school.license_version} is saved but the school still has version{" "}
            {school.license_pushed_version || "none"}.
          </p>
          {school.license_push_error && <p className="mt-1 text-xs">{school.license_push_error}</p>}
          <form action={pushLicenseAction} className="mt-2">
            <input type="hidden" name="schoolId" value={school.id} />
            <button className="rounded border border-amber-400 px-3 py-1 hover:bg-amber-100">
              Retry push
            </button>
          </form>
        </div>
      )}

      <form action={setLicenseAction} className="grid gap-4 sm:grid-cols-2">
        <input type="hidden" name="schoolId" value={school.id} />
        <label className="block text-sm">
          <span className="mb-1 block text-slate-700">Type</span>
          <select
            name="kind"
            defaultValue={hasLicense && !school.license_is_trial ? "paid" : "trial"}
            className={input}
          >
            <option value="trial">Trial</option>
            <option value="paid">Paid</option>
          </select>
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-slate-700">Academic session</span>
          <input
            name="session"
            required
            defaultValue={school.license_session ?? ""}
            placeholder="2026/2027"
            className={input}
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-slate-700">Valid until (end of day, UTC)</span>
          <input
            name="valid_until"
            type="date"
            required
            defaultValue={day(school.license_valid_until) || defaultValidUntil()}
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
            defaultValue={grace}
            className={input}
          />
          <span className="mt-1 block text-xs text-slate-500">
            Everything still works during grace; after it the school is read-only.
          </span>
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-slate-700">Student cap</span>
          <input
            name="student_cap"
            type="number"
            min={1}
            defaultValue={school.included_students > 0 ? school.included_students : ""}
            className={input}
          />
          <span className="mt-1 block text-xs text-slate-500">
            Blank means no cap. Only drives a warning banner; it never blocks.
          </span>
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-slate-700">Add-ons</span>
          <input
            name="features"
            defaultValue={school.features?.join(", ")}
            placeholder="messaging, transport"
            className={input}
          />
          <span className="mt-1 block text-xs text-slate-500">Comma separated.</span>
        </label>
        <div className="sm:col-span-2">
          <button className="rounded bg-slate-900 px-4 py-2 text-sm text-white hover:bg-slate-700">
            {hasLicense ? "Save and push new version" : "Set licence and push"}
          </button>
        </div>
      </form>

      {isOwner && hasLicense && (
        <form
          action={revokeLicenseAction}
          className="flex flex-wrap items-center gap-3 rounded border border-red-200 bg-red-50 p-3 text-sm"
        >
          <input type="hidden" name="schoolId" value={school.id} />
          <label className="flex items-center gap-2 text-red-900">
            <input type="checkbox" name="confirm" value="yes" />
            Make this school read-only now
          </label>
          <button className="rounded border border-red-300 px-3 py-1 text-red-900 hover:bg-red-100">
            Revoke licence
          </button>
          <span className="text-xs text-red-800">
            Undone by setting a new licence. Nothing is deleted.
          </span>
        </form>
      )}
    </div>
  );
}
