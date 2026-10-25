import { StatusBadge, ago } from "@/components/badges";

export type RecentJob = {
  id: string;
  type: string;
  status: string;
  error: string | null;
  result: { to_tag?: string; migrations?: string[]; already_registered?: boolean } | null;
  payload: { tag?: string } | null;
  created_at: string;
  schools: { slug: string } | null;
};

const TITLE: Record<string, string> = {
  school_rollback: "Roll back",
  register_release: "Register release",
};

function summary(j: RecentJob): string {
  if (j.status === "failed") return j.error ?? "Failed.";
  if (j.type === "school_rollback") {
    return j.result?.to_tag ? `Now on ${j.result.to_tag.slice(0, 10)}` : "";
  }
  if (j.type === "register_release" && j.status === "succeeded") {
    if (j.result?.already_registered) return "Already registered";
    const n = j.result?.migrations?.length ?? 0;
    return `${n} new migration${n === 1 ? "" : "s"}`;
  }
  return "";
}

// What the standalone jobs did. A rollback or a registration happens in the
// background, so this is where a failure shows up.
export function RecentJobs({ jobs }: { jobs: RecentJob[] }) {
  if (jobs.length === 0) return null;
  return (
    <section className="space-y-3">
      <h2 className="font-semibold">Recent actions</h2>
      <ul className="space-y-2 text-sm">
        {jobs.map((j) => (
          <li key={j.id} className="flex flex-wrap items-start gap-2">
            <StatusBadge status={j.status} />
            <span className="font-medium">{TITLE[j.type] ?? j.type}</span>
            <span className="text-slate-600">
              {j.schools?.slug ?? (j.payload?.tag ? j.payload.tag.slice(0, 10) : "")}
            </span>
            <span className="text-xs text-slate-500">{ago(j.created_at)}</span>
            <span
              className={j.status === "failed" ? "text-xs text-red-700" : "text-xs text-slate-600"}
            >
              {summary(j)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
