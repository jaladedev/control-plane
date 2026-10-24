import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { RunnerMigration } from "@/lib/migrate/runner";

// Everything the worker reads and writes in the control-plane database,
// behind one interface so the handlers can be tested without a database. The
// state machine itself (claim, start, complete, retry) is in SQL functions;
// this class only calls them.

export type Job = {
  id: string;
  type: string;
  school_id: string | null;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
};

export type StepContext = {
  step: { id: string; rollout_id: string; school_id: string; attempt: number };
  rollout: { id: string; image_tag: string; status: string; release_seq: number };
  school: {
    id: string;
    slug: string;
    status: string;
    hostnames: string[];
    image_tag: string | null;
  };
};

export type SchoolPatch = Partial<{
  schema_version: string | null;
  image_tag: string;
  app_version: string;
  credentials_status: "ok" | "auth_failed" | "paused" | "unreachable";
}>;

export interface Store {
  claimJob(worker: string, types: string[]): Promise<Job | null>;
  touchJob(jobId: string, worker: string): Promise<boolean>;
  finishJob(
    jobId: string,
    worker: string,
    ok: boolean,
    result: unknown,
    error: string | null
  ): Promise<void>;
  retryJob(jobId: string, worker: string, error: string, delaySeconds: number): Promise<void>;
  requeueStale(minutes: number): Promise<number>;
  enqueueScans(): Promise<number>;

  loadStep(stepId: string): Promise<StepContext | null>;
  startStep(stepId: string): Promise<boolean>;
  completeStep(stepId: string, ok: boolean, result: unknown, error: string | null): Promise<void>;

  registeredMigrations(): Promise<RunnerMigration[]>;
  releaseSeqs(): Promise<Map<string, number>>;
  schoolForScan(schoolId: string): Promise<{ id: string; slug: string } | null>;
  reconcileRuns(schoolId: string, appliedVersions: string[]): Promise<void>;
  startRun(schoolId: string, stepId: string | null, migrationId: string): Promise<string>;
  finishRun(runId: string, ok: boolean, error?: string): Promise<void>;
  updateSchool(schoolId: string, patch: SchoolPatch): Promise<void>;
}

function check<T>(res: { data: T; error: { message: string } | null }, what: string): T {
  if (res.error) throw new Error(`${what}: ${res.error.message}`);
  return res.data;
}

// For results that must exist: a null here means the database misbehaved.
function need<T>(
  res: { data: T; error: { message: string } | null },
  what: string
): NonNullable<T> {
  if (res.error) throw new Error(`${what}: ${res.error.message}`);
  if (res.data === null || res.data === undefined) throw new Error(`${what}: no data returned`);
  return res.data as NonNullable<T>;
}

export class SupabaseStore implements Store {
  private readonly db: SupabaseClient;

  // `client` is for tests, which run the store against a real database through
  // an adapter instead of the Supabase API.
  constructor(url: string, serviceRoleKey: string, client?: SupabaseClient) {
    this.db =
      client ??
      createClient(url, serviceRoleKey, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
  }

  async claimJob(worker: string, types: string[]) {
    const rows = check(
      await this.db.rpc("claim_job", { p_worker: worker, p_types: types }),
      "claim_job"
    );
    return ((rows as Job[] | null)?.[0] ?? null) as Job | null;
  }
  async touchJob(jobId: string, worker: string) {
    return (
      check(await this.db.rpc("touch_job", { p_job: jobId, p_worker: worker }), "touch_job") ===
      true
    );
  }
  async finishJob(
    jobId: string,
    worker: string,
    ok: boolean,
    result: unknown,
    error: string | null
  ) {
    check(
      await this.db.rpc("finish_job", {
        p_job: jobId,
        p_worker: worker,
        p_ok: ok,
        p_result: result ?? null,
        p_error: error,
      }),
      "finish_job"
    );
  }
  async retryJob(jobId: string, worker: string, error: string, delaySeconds: number) {
    check(
      await this.db.rpc("retry_job", {
        p_job: jobId,
        p_worker: worker,
        p_error: error,
        p_delay_seconds: delaySeconds,
      }),
      "retry_job"
    );
  }
  async requeueStale(minutes: number) {
    return Number(
      check(
        await this.db.rpc("requeue_stale_jobs", { p_stale_minutes: minutes }),
        "requeue_stale_jobs"
      ) ?? 0
    );
  }
  async enqueueScans() {
    return Number(
      check(await this.db.rpc("enqueue_schema_scan", { p_school: null }), "enqueue_schema_scan") ??
        0
    );
  }

  async loadStep(stepId: string): Promise<StepContext | null> {
    const step = check(
      await this.db
        .from("rollout_steps")
        .select("id, rollout_id, school_id, attempt")
        .eq("id", stepId)
        .maybeSingle(),
      "load step"
    );
    if (!step) return null;
    const rollout = need(
      await this.db
        .from("rollouts")
        .select("id, image_tag, status, release_id")
        .eq("id", step.rollout_id)
        .single(),
      "load rollout"
    );
    const release = need(
      await this.db.from("releases").select("seq").eq("id", rollout.release_id).single(),
      "load release"
    );
    const school = need(
      await this.db
        .from("schools")
        .select("id, slug, status, hostnames, image_tag")
        .eq("id", step.school_id)
        .single(),
      "load school"
    );
    return {
      step,
      rollout: {
        id: rollout.id,
        image_tag: rollout.image_tag,
        status: rollout.status,
        release_seq: Number(release.seq),
      },
      school: { ...school, hostnames: school.hostnames ?? [] },
    };
  }
  async startStep(stepId: string) {
    return check(await this.db.rpc("start_step", { p_step: stepId }), "start_step") === true;
  }
  async completeStep(stepId: string, ok: boolean, result: unknown, error: string | null) {
    check(
      await this.db.rpc("complete_step", {
        p_step: stepId,
        p_ok: ok,
        p_result: result ?? null,
        p_error: error,
      }),
      "complete_step"
    );
  }

  async registeredMigrations(): Promise<RunnerMigration[]> {
    const rows = need(
      await this.db
        .from("migrations")
        .select("id, version, name, sql, checksum, kind, min_app_version, release_id")
        .order("version"),
      "load migrations"
    );
    const seqs = need(await this.db.from("releases").select("id, seq"), "load releases");
    const seqById = new Map(seqs.map((r) => [r.id as string, Number(r.seq)]));
    return rows.map((m) => ({
      id: m.id,
      version: m.version,
      name: m.name,
      sql: m.sql,
      checksum: m.checksum,
      kind: m.kind,
      minAppVersion: m.min_app_version,
      releaseSeq: seqById.get(m.release_id) ?? Number.MAX_SAFE_INTEGER,
    }));
  }
  async releaseSeqs() {
    const rows = need(await this.db.from("releases").select("image_tag, seq"), "load releases");
    return new Map(rows.map((r) => [r.image_tag as string, Number(r.seq)]));
  }
  async schoolForScan(schoolId: string) {
    return check(
      await this.db.from("schools").select("id, slug").eq("id", schoolId).maybeSingle(),
      "load school"
    );
  }

  // Runs left "running" by a worker that died: the school's own table says
  // whether the migration landed.
  async reconcileRuns(schoolId: string, appliedVersions: string[]) {
    const stuck = need(
      await this.db
        .from("migration_runs")
        .select("id, migrations(version)")
        .eq("school_id", schoolId)
        .eq("status", "running"),
      "load running runs"
    );
    const applied = new Set(appliedVersions);
    for (const run of stuck as unknown as {
      id: string;
      migrations: { version: string } | null;
    }[]) {
      const landed = run.migrations ? applied.has(run.migrations.version) : false;
      check(
        await this.db
          .from("migration_runs")
          .update({
            status: landed ? "succeeded" : "failed",
            finished_at: new Date().toISOString(),
            error: landed
              ? null
              : "The worker stopped before this migration finished; it is not applied.",
          })
          .eq("id", run.id),
        "reconcile run"
      );
    }
  }
  async startRun(schoolId: string, stepId: string | null, migrationId: string) {
    const row = need(
      await this.db
        .from("migration_runs")
        .insert({
          school_id: schoolId,
          step_id: stepId,
          migration_id: migrationId,
          status: "running",
        })
        .select("id")
        .single(),
      "start run"
    );
    return row.id as string;
  }
  async finishRun(runId: string, ok: boolean, error?: string) {
    check(
      await this.db
        .from("migration_runs")
        .update({
          status: ok ? "succeeded" : "failed",
          finished_at: new Date().toISOString(),
          error: error?.slice(0, 1000) ?? null,
        })
        .eq("id", runId),
      "finish run"
    );
  }
  async updateSchool(schoolId: string, patch: SchoolPatch) {
    check(await this.db.from("schools").update(patch).eq("id", schoolId), "update school");
  }
}
