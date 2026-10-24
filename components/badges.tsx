import type { HealthStatus } from "@/lib/health";
import type { LicenseState } from "@/lib/schools";

const base = "inline-block rounded px-2 py-0.5 text-xs font-medium";

const HEALTH: Record<HealthStatus, string> = {
  up: "bg-green-100 text-green-800",
  degraded: "bg-amber-100 text-amber-800",
  down: "bg-red-100 text-red-800",
  unknown: "bg-slate-100 text-slate-600",
};

const LICENSE: Record<LicenseState, string> = {
  active: "bg-green-100 text-green-800",
  grace: "bg-amber-100 text-amber-800",
  expired: "bg-red-100 text-red-800",
  none: "bg-slate-100 text-slate-600",
};

export function HealthBadge({ status }: { status: HealthStatus }) {
  return <span className={`${base} ${HEALTH[status] ?? HEALTH.unknown}`}>{status}</span>;
}

export function LicenseBadge({ state }: { state: LicenseState }) {
  return (
    <span className={`${base} ${LICENSE[state]}`}>{state === "none" ? "no licence" : state}</span>
  );
}

/** "3 min ago", or a dash when never. */
export function ago(iso: string | null, now: Date = new Date()): string {
  if (!iso) return "never";
  const seconds = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 1000));
  if (seconds < 90) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

const STATUS: Record<string, string> = {
  pending: "bg-slate-100 text-slate-600",
  queued: "bg-sky-100 text-sky-800",
  running: "bg-blue-100 text-blue-800",
  succeeded: "bg-green-100 text-green-800",
  failed: "bg-red-100 text-red-800",
  cancelled: "bg-slate-200 text-slate-600",
  halted: "bg-red-100 text-red-800",
};

/** Rollout and step statuses. */
export function StatusBadge({ status }: { status: string }) {
  return <span className={`${base} ${STATUS[status] ?? STATUS.pending}`}>{status}</span>;
}
