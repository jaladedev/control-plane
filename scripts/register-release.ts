import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { planRegistration } from "@/lib/migrate/register";

// Registers a release (an image tag CI built) and the migrations it ships.
//
//   npm run register-release -- --tag <40-hex commit> --dir <school_app>/supabase/migrations \
//     --by you@example.com [--baseline <14-digit version>] [--notes "..."] [--dry-run]
//
// --baseline marks every migration up to and including that version as "all
// schools already have this": they are registered as expand and skip the
// contract-risk check. Use it once, for the first registration.
// Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (from the environment or
// .env.local). --by must be an active owner; the audit row is written first.

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
  const tag = arg("tag");
  const dir = arg("dir");
  const by = arg("by")?.toLowerCase();
  const baseline = arg("baseline");
  const notes = arg("notes") ?? null;
  const dryRun = flag("dry-run");

  if (!tag || !/^[0-9a-f]{40}$/.test(tag)) fail("--tag must be a full 40-character commit hash.");
  if (!dir || !existsSync(dir)) fail("--dir must be the school_app supabase/migrations folder.");
  if (!by) fail("--by <owner email> is required.");
  if (baseline !== undefined && !/^\d{14}$/.test(baseline))
    fail("--baseline must be a 14-digit version.");

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) fail("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
  const db = createClient(url!, key!, { auth: { persistSession: false, autoRefreshToken: false } });

  const { data: owner, error: ownerError } = await db
    .from("dashboard_users")
    .select("id, email, role, is_active")
    .eq("email", by!)
    .maybeSingle();
  if (ownerError) fail(`Could not check --by: ${ownerError.message}`);
  if (!owner || owner.role !== "owner" || owner.is_active !== true)
    fail(`${by} is not an active owner.`);

  const files = readdirSync(dir!)
    .filter((f) => f.endsWith(".sql"))
    .map((name) => ({ name, content: readFileSync(join(dir!, name), "utf8") }));
  if (files.length === 0) fail("No .sql files found in --dir.");

  const { data: registered, error: regError } = await db
    .from("migrations")
    .select("version, name, checksum");
  if (regError) fail(`Could not read the registry: ${regError.message}`);
  const plan = planRegistration(files, registered ?? [], { baseline });

  if (plan.errors.length > 0) {
    console.error(`Cannot register ${tag!.slice(0, 12)}:`);
    for (const e of plan.errors) console.error(`  - ${e}`);
    process.exit(1);
  }

  const { data: existing } = await db
    .from("releases")
    .select("id")
    .eq("image_tag", tag!)
    .maybeSingle();
  if (existing && plan.newMigrations.length === 0) {
    console.log(
      `Release ${tag!.slice(0, 12)} is already registered and has no new migrations. Nothing to do.`
    );
    return;
  }
  console.log(
    `Release ${tag!.slice(0, 12)}: ${plan.newMigrations.length} new migration(s), ${plan.unchanged} already registered.`
  );
  for (const m of plan.newMigrations) console.log(`  + ${m.name}  [${m.kind}]`);
  if (dryRun) {
    console.log("Dry run: nothing was written.");
    return;
  }

  // Audit first, then the single atomic registration.
  const { error: auditError } = await db.from("audit_log").insert({
    actor_id: owner!.id,
    actor_email: owner!.email,
    role: owner!.role,
    action: "release.register",
    details: {
      tag,
      migrations: plan.newMigrations.map((m) => m.name),
      baseline: baseline ?? null,
      via: "register-release",
    },
  });
  if (auditError) fail(`Could not write the audit log: ${auditError.message}`);

  const { error } = await db.rpc("register_release", {
    p_tag: tag,
    p_notes: notes,
    p_by: owner!.email,
    p_migrations: plan.newMigrations.map((m) => ({
      version: m.version,
      name: m.name,
      checksum: m.checksum,
      kind: m.kind,
      min_app_version: m.minAppVersion ?? "",
      sql: m.sql,
    })),
  });
  if (error) {
    await db.from("audit_log").insert({
      actor_id: owner!.id,
      actor_email: owner!.email,
      role: owner!.role,
      action: "release.register.failed",
      details: { tag, error: error.message },
    });
    fail(`Registration failed (nothing was recorded): ${error.message}`);
  }
  console.log("Registered.");
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
