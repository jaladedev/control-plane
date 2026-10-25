import { existsSync, readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { adoptSchool, planAdoption } from "@/lib/migrate/adopt";
import { readAppliedVersionsReadOnly } from "@/lib/migrate/runner";
import { makeConnect } from "@/worker/connect";
import { EnvSecrets } from "@/worker/secrets";

// Adopts a school whose database already has its schema from before the runner
// existed: records the migrations up to a version as applied, WITHOUT running
// them, so its first rollout applies only what is newer.
//
//   npm run adopt-school -- --slug greenfield --through <14-digit version> \
//     --by you@example.com [--apply]
//
// Without --apply it only shows what it would record. Check first that the
// school's database really has every change in those migrations (compare it with
// a database built from the migration files): this records history, it cannot
// verify it. Run it once per existing school, after registering the release.
// Needs SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and SCHOOL_DB_URLS (the worker's
// settings; from the environment or .env.local). --by must be an active owner,
// and the audit row is written before anything changes.

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
const flag = (name: string) => process.argv.includes(`--${name}`);
const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

function loadEnvFile() {
  if (!existsSync(".env.local")) return;
  for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

async function main() {
  loadEnvFile();
  const slug = arg("slug");
  const through = arg("through");
  const by = arg("by")?.toLowerCase();
  const apply = flag("apply");
  if (!slug || !/^[a-z0-9][a-z0-9-]*$/.test(slug)) fail("--slug <school slug> is required.");
  if (!through || !/^\d{14}$/.test(through)) fail("--through must be a 14-digit version.");
  if (!by) fail("--by <owner email> is required.");

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) fail("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
  const secrets = new EnvSecrets(process.env.SCHOOL_DB_URLS);
  const control = createClient(url!, key!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: owner } = await control
    .from("dashboard_users")
    .select("id, email, role, is_active")
    .eq("email", by!)
    .maybeSingle();
  if (!owner || owner.role !== "owner" || owner.is_active !== true)
    fail(`${by} is not an active owner.`);

  const { data: school } = await control
    .from("schools")
    .select("id, slug")
    .eq("slug", slug!)
    .maybeSingle();
  if (!school) fail(`There is no school "${slug}".`);
  const { data: registered, error: regError } = await control
    .from("migrations")
    .select("version, name")
    .order("version");
  if (regError) fail(`Could not read the registry: ${regError.message}`);
  if (!registered?.length) fail("No migrations are registered yet. Register a release first.");

  const conn = await makeConnect(process.env.SCHOOL_DB_CA_FILE)(
    await secrets.schoolDatabaseUrl(slug!)
  );
  try {
    const applied = await readAppliedVersionsReadOnly(conn.db);
    const plan = planAdoption(registered!, applied, through!);
    if (plan.errors.length > 0) {
      console.error(`Cannot adopt ${slug}:`);
      for (const e of plan.errors) console.error(`  - ${secrets.redact(e)}`);
      process.exit(1);
    }
    console.log(
      `${slug}: ${applied.length} migration(s) recorded already; would record ${plan.toRecord.length} more, up to ${through}.`
    );
    if (plan.toRecord.length === 0) {
      console.log("Nothing to do.");
      return;
    }
    console.log(`  first: ${plan.toRecord[0].version}   last: ${plan.toRecord.at(-1)!.version}`);
    if (!apply) {
      console.log(
        "Dry run: nothing was written. This records history WITHOUT running it, so check the school's\n" +
          "schema really has all of these changes first. Then run again with --apply."
      );
      return;
    }

    const { error: auditError } = await control.from("audit_log").insert({
      actor_id: owner!.id,
      actor_email: owner!.email,
      role: owner!.role,
      action: "school.adopt",
      school_id: school!.id,
      details: { slug, through, recorded: plan.toRecord.length, via: "adopt-school" },
    });
    if (auditError) fail(`Could not write the audit log: ${auditError.message}`);

    const recorded = await adoptSchool(conn.db, plan);
    console.log(`Recorded ${recorded.length} migration(s).`);
    const { error: scanError } = await control.rpc("enqueue_schema_scan", { p_school: school!.id });
    console.log(
      scanError
        ? `Could not ask the worker to refresh versions (${scanError.message}); press "Refresh versions" on the Migrations page.`
        : "Asked the worker to refresh the school's version."
    );
  } finally {
    await conn.close().catch(() => {});
  }
}

main().catch((e) => fail(secretsSafe(e instanceof Error ? e.message : String(e))));

function secretsSafe(message: string): string {
  return new EnvSecrets(process.env.SCHOOL_DB_URLS).redact(message);
}
