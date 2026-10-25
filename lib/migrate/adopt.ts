import { LOCK_KEY, readAppliedVersions, type PgLike } from "@/lib/migrate/runner";

// Adopting a school whose database already has the schema from before the
// runner existed. Its own migration table is empty or missing, so the runner
// would try to apply every migration again and stop at "already exists". Adoption
// records the migrations up to a version as already applied, WITHOUT running
// them. That is only true if the school's schema really has those changes, which
// no code can prove: the person adopting a school has to have checked.
//
// The rules refuse anything that smells like drift rather than guess.

export type AdoptPlan = {
  toRecord: { version: string; name: string }[];
  alreadyRecorded: number;
  errors: string[];
};

export function planAdoption(
  registered: { version: string; name: string }[],
  applied: string[],
  through: string
): AdoptPlan {
  const errors: string[] = [];
  if (!/^\d{14}$/.test(through)) {
    return { toRecord: [], alreadyRecorded: 0, errors: ["--through must be a 14-digit version."] };
  }
  const known = new Map(registered.map((r) => [r.version, r]));
  if (!known.has(through)) {
    errors.push(`${through} is not a registered migration version.`);
  }

  const unknown = applied.filter((v) => !known.has(v)).sort();
  if (unknown.length > 0) {
    errors.push(
      `The school's table records migrations the control plane does not know (${unknown.slice(0, 3).join(", ")}${unknown.length > 3 ? ", …" : ""}). Adoption is for schools with no history; this one has diverged, so look into it first.`
    );
  }
  const newer = applied.filter((v) => v > through).sort();
  if (newer.length > 0) {
    errors.push(
      `The school's table already records ${newer[0]}, which is newer than --through ${through}. Use --through ${newer.at(-1)} or later.`
    );
  }

  const have = new Set(applied);
  const toRecord = registered
    .filter((r) => r.version <= through && !have.has(r.version))
    .sort((a, b) => a.version.localeCompare(b.version))
    .map((r) => ({ version: r.version, name: r.name }));
  return {
    toRecord: errors.length > 0 ? [] : toRecord,
    alreadyRecorded: registered.filter((r) => r.version <= through && have.has(r.version)).length,
    errors,
  };
}

/**
 * Writes the plan into the school's own table, in one transaction, under the same
 * lock the runner uses (so it cannot overlap a migration run). The table is read
 * again under the lock: the plan may be stale. Returns the versions recorded.
 */
export async function adoptSchool(db: PgLike, plan: AdoptPlan): Promise<string[]> {
  if (plan.errors.length > 0) throw new Error(plan.errors.join(" "));
  const lock = await db.query("select pg_try_advisory_lock($1) as ok", [LOCK_KEY]);
  if (lock.rows[0]?.ok !== true) {
    throw new Error(
      "A migration run is in progress on this school's database. Try again when it has finished."
    );
  }
  try {
    const have = new Set(await readAppliedVersions(db));
    const todo = plan.toRecord.filter((m) => !have.has(m.version));
    await db.query("begin");
    try {
      await db.query("set local lock_timeout = '30s'");
      for (const m of todo) {
        await db.query(
          "insert into supabase_migrations.schema_migrations (version, name, statements) values ($1, $2, $3)",
          [m.version, m.name, []]
        );
      }
      await db.query("commit");
    } catch (error) {
      await db.query("rollback").catch(() => {});
      throw error;
    }
    return todo.map((m) => m.version);
  } finally {
    await db.query("select pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => {});
  }
}
