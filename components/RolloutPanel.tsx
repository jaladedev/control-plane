import { AutoRefresh } from "@/components/AutoRefresh";
import { StatusBadge, ago } from "@/components/badges";
import { availableControls, progress, type StepInfo } from "@/lib/rollout-view";
import { cancelRolloutAction, releaseAction, retryStepAction } from "@/app/migrations/actions";

type Step = StepInfo & {
  id: string;
  attempt: number;
  error: string | null;
  result: { applied?: string[]; from_tag?: string | null; to_tag?: string | null } | null;
  finished_at: string | null;
  schools: { slug: string; name: string } | null;
};

type Rollout = {
  id: string;
  image_tag: string;
  status: string;
  released_through: number;
  batch_size: number;
  halt_reason: string | null;
  created_by: string | null;
  created_at: string;
};

const short = (tag: string | null | undefined) => (tag ? tag.slice(0, 10) : "—");
const input = "rounded border border-slate-300 px-2 py-1 text-sm";

// The rollout in progress: its steps with live results, and the controls that
// release the next stage in canary order. The database refuses anything out of
// order; the buttons only offer what it would accept.
export function RolloutPanel({
  rollout,
  steps,
  isOwner,
}: {
  rollout: Rollout;
  steps: Step[];
  isOwner: boolean;
}) {
  const p = progress(steps);
  const c = availableControls(rollout, steps);
  const moving = rollout.status === "running" && (p.active > 0 || c.waiting);
  const failed = steps.find((s) => s.status === "failed");

  return (
    <section className="space-y-4 rounded border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="font-semibold">
          Rollout of <span className="font-mono">{short(rollout.image_tag)}</span>
        </h2>
        <StatusBadge status={rollout.status} />
        <span className="text-sm text-slate-500">
          {p.done} of {p.total} schools done · batches of {rollout.batch_size} · started{" "}
          {ago(rollout.created_at)}
          {rollout.created_by ? ` by ${rollout.created_by}` : ""}
        </span>
        {moving && (
          <span className="ml-auto">
            <AutoRefresh />
          </span>
        )}
      </div>

      {rollout.status === "halted" && (
        <p role="alert" className="rounded bg-red-50 p-3 text-sm text-red-800">
          Stopped on a failure: {rollout.halt_reason ?? "a step failed"}. Nothing further will run.
          Fix the cause and retry the step, or cancel the rollout.
        </p>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-slate-200 text-slate-600">
            <tr>
              <th className="px-2 py-2">#</th>
              <th className="px-2 py-2">School</th>
              <th className="px-2 py-2">Stage</th>
              <th className="px-2 py-2">Status</th>
              <th className="px-2 py-2">Migrations</th>
              <th className="px-2 py-2">Version</th>
              <th className="px-2 py-2">Result</th>
              {isOwner && <th className="px-2 py-2" />}
            </tr>
          </thead>
          <tbody>
            {steps.map((s) => (
              <tr key={s.id} className="border-b border-slate-100 align-top last:border-0">
                <td className="px-2 py-2 text-slate-500">{s.position}</td>
                <td className="px-2 py-2 font-medium">{s.schools?.name ?? "?"}</td>
                <td className="px-2 py-2">
                  {s.stage === "batch" ? `batch ${s.batch_no}` : s.stage}
                </td>
                <td className="px-2 py-2">
                  <StatusBadge status={s.status} />
                  {s.attempt > 1 && (
                    <span className="ml-1 text-xs text-slate-500">attempt {s.attempt}</span>
                  )}
                </td>
                <td className="px-2 py-2">
                  {s.result?.applied ? `${s.result.applied.length} applied` : "—"}
                </td>
                <td className="px-2 py-2 font-mono text-xs">
                  {s.result?.to_tag
                    ? `${short(s.result.from_tag)} → ${short(s.result.to_tag)}`
                    : "—"}
                </td>
                <td className="max-w-md px-2 py-2 text-xs text-red-700">{s.error ?? ""}</td>
                {isOwner && (
                  <td className="px-2 py-2">
                    {s.status === "failed" && rollout.status === "halted" && (
                      <form action={retryStepAction}>
                        <input type="hidden" name="stepId" value={s.id} />
                        <button className="rounded border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100">
                          Retry
                        </button>
                      </form>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {isOwner && rollout.status === "running" && (
        <div className="space-y-3 border-t border-slate-200 pt-4">
          {c.waiting && (
            <p className="text-sm text-slate-600">
              Waiting for the released schools to finish before more can be released.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <ReleaseButton
              rolloutId={rollout.id}
              target="test"
              label="Release test school"
              enabled={c.test}
            />
            <ReleaseButton
              rolloutId={rollout.id}
              target="pilot"
              label="Release pilot"
              enabled={c.pilot}
            />
          </div>
          <div className="flex flex-wrap items-end gap-4">
            <ReleaseWithConfirm
              rolloutId={rollout.id}
              target="next_batch"
              label="Release next batch"
              enabled={c.next_batch}
            />
            <ReleaseWithConfirm
              rolloutId={rollout.id}
              target="all"
              label="Release all remaining"
              enabled={c.all}
            />
          </div>
          <p className="text-xs text-slate-500">
            Order is enforced: test, then pilot, then batches. Schools run one at a time, and the
            first failure stops everything.{" "}
            {failed
              ? ""
              : "A school is migrated, deployed and health-checked before the next one starts."}
          </p>
        </div>
      )}

      {isOwner && (rollout.status === "running" || rollout.status === "halted") && (
        <form
          action={cancelRolloutAction}
          className="flex flex-wrap items-center gap-3 border-t border-slate-200 pt-4 text-sm"
        >
          <input type="hidden" name="rolloutId" value={rollout.id} />
          <label className="flex items-center gap-2">
            <input type="checkbox" name="confirm" value="yes" />
            Stop this rollout
          </label>
          <button className="rounded border border-red-300 px-3 py-1 text-red-900 hover:bg-red-50">
            Cancel rollout
          </button>
          <span className="text-xs text-slate-500">
            A school that is running right now is not interrupted: half a migration is worse than a
            finished one.
          </span>
        </form>
      )}
    </section>
  );
}

function ReleaseButton({
  rolloutId,
  target,
  label,
  enabled,
}: {
  rolloutId: string;
  target: string;
  label: string;
  enabled: boolean;
}) {
  return (
    <form action={releaseAction}>
      <input type="hidden" name="rolloutId" value={rolloutId} />
      <input type="hidden" name="target" value={target} />
      <button
        disabled={!enabled}
        className="rounded bg-slate-900 px-3 py-1.5 text-sm text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-300"
      >
        {label}
      </button>
    </form>
  );
}

function ReleaseWithConfirm({
  rolloutId,
  target,
  label,
  enabled,
}: {
  rolloutId: string;
  target: string;
  label: string;
  enabled: boolean;
}) {
  return (
    <form action={releaseAction} className="flex items-end gap-2">
      <input type="hidden" name="rolloutId" value={rolloutId} />
      <input type="hidden" name="target" value={target} />
      <label className="text-xs text-slate-600">
        Type ALL to confirm
        <input
          name="confirm"
          autoComplete="off"
          disabled={!enabled}
          className={`${input} mt-1 block w-28`}
        />
      </label>
      <button
        disabled={!enabled}
        className="rounded bg-slate-900 px-3 py-1.5 text-sm text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-300"
      >
        {label}
      </button>
    </form>
  );
}
