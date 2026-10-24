// Derived facts for the Migrations screen. Pure. The canary rules are
// enforced in the database (release_rollout); these only decide which buttons
// to offer, so a rule changed there must be changed here or the button lies.

export type SchoolInfo = {
  id: string;
  slug: string;
  name: string;
  status: string;
  rollout_group: string;
  hostnames: string[] | null;
  supabase_project_ref: string | null;
};

export type StepInfo = {
  position: number;
  stage: "test" | "pilot" | "batch";
  batch_no: number;
  status: "pending" | "queued" | "running" | "succeeded" | "failed" | "cancelled";
};

export type RolloutInfo = { status: string; released_through: number };

/** Who a new rollout would include, and who it would leave out and why. */
export function planPreview(schools: SchoolInfo[]) {
  const included = { test: 0, pilot: 0, standard: 0 };
  const excluded: { slug: string; reason: string }[] = [];
  for (const s of schools) {
    if (s.status === "archived") continue;
    const reason =
      s.status !== "active"
        ? `status is ${s.status}`
        : !s.hostnames?.length
          ? "no hostname"
          : !s.supabase_project_ref
            ? "no Supabase project ref"
            : null;
    if (reason) excluded.push({ slug: s.slug, reason });
    else included[s.rollout_group as keyof typeof included]++;
  }
  return { included, excluded };
}

/** Migrations the school lacks, by version order; null when its version is unknown. */
export function pendingCount(
  schemaVersion: string | null,
  registeredVersions: string[]
): number | null {
  if (!schemaVersion) return null;
  return registeredVersions.filter((v) => v > schemaVersion).length;
}

export type AppState = { state: "current" | "behind" | "unknown"; by: number };

/** How many releases behind a school's running image is. Unregistered tags are "unknown". */
export function appState(
  tag: string | null,
  seqByTag: Map<string, number>,
  latestSeq: number | null
): AppState {
  const seq = tag ? seqByTag.get(tag) : undefined;
  if (seq === undefined || latestSeq === null) return { state: "unknown", by: 0 };
  return seq >= latestSeq ? { state: "current", by: 0 } : { state: "behind", by: latestSeq - seq };
}

export function progress(steps: StepInfo[]) {
  const count = (s: StepInfo["status"]) => steps.filter((x) => x.status === s).length;
  return {
    total: steps.length,
    done: count("succeeded"),
    failed: count("failed"),
    active: count("running") + count("queued"),
  };
}

export type Controls = {
  test: boolean;
  pilot: boolean;
  next_batch: boolean;
  all: boolean;
  waiting: boolean;
};

/** Which release buttons make sense now. Mirrors release_rollout in SQL. */
export function availableControls(rollout: RolloutInfo, steps: StepInfo[]): Controls {
  const none: Controls = {
    test: false,
    pilot: false,
    next_batch: false,
    all: false,
    waiting: false,
  };
  if (rollout.status !== "running") return none;
  const released = steps.filter((s) => s.position <= rollout.released_through);
  if (released.some((s) => s.status !== "succeeded")) return { ...none, waiting: true };

  const stage = (name: StepInfo["stage"]) => steps.filter((s) => s.stage === name);
  const testsDone = stage("test").every((s) => s.status === "succeeded");
  const pilotsDone = stage("pilot").every((s) => s.status === "succeeded");
  const maxPos = (list: StepInfo[]) => list.reduce((m, s) => Math.max(m, s.position), 0);
  const beyond = steps.filter(
    (s) => s.position > rollout.released_through && s.status === "pending"
  );

  return {
    waiting: false,
    test: maxPos(stage("test")) > rollout.released_through,
    pilot:
      testsDone && stage("pilot").length > 0 && maxPos(stage("pilot")) > rollout.released_through,
    next_batch: testsDone && pilotsDone && beyond.some((s) => s.stage === "batch"),
    all: testsDone && pilotsDone && beyond.length > 0,
  };
}

/** The oldest queued job's age in seconds, or null: a sign the worker is not running. */
export function stalledQueueSeconds(
  queued: { created_at: string; run_after: string }[],
  now = new Date()
): number | null {
  const due = queued.filter((j) => new Date(j.run_after) <= now);
  if (due.length === 0) return null;
  const oldest = Math.min(...due.map((j) => new Date(j.created_at).getTime()));
  const age = Math.round((now.getTime() - oldest) / 1000);
  return age >= 120 ? age : null;
}
