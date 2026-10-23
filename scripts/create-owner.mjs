#!/usr/bin/env node
/**
 * Creates the first owner. Run once, after the migration, from a trusted
 * machine, from the project folder:
 *
 *   npm run create-owner -- you@example.com "a-long-temporary-password"
 *
 * SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are read from the environment, or
 * from .env.local if they are not set. The npm script also sets Node to prefer
 * IPv4, which fixes "fetch failed" on networks where IPv6 lookups hang.
 *
 * It refuses to run if an owner already exists (add further users from the
 * Users page). The owner enrols an authenticator app at first sign-in. Turn
 * off "Allow new users to sign up" in the Supabase dashboard (Authentication,
 * Sign In / Providers) so only people added here can ever have a login.
 */
import { existsSync, readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

// Fill in anything not already set from .env.local (KEY=value lines).
if (existsSync(".env.local")) {
  for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
    }
  }
}

const [email, password] = process.argv.slice(2);
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!email || !password || !url || !key) {
  console.error('Usage: npm run create-owner -- <email> "<password>"');
  console.error(
    "Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment or .env.local."
  );
  process.exit(2);
}

// Says what went wrong, including the underlying network error that supabase-js
// hides behind "fetch failed" (for example a host that does not exist).
function describe(error) {
  const cause = error?.cause;
  const detail = cause ? ` (${cause.code ?? cause.name}: ${cause.message})` : "";
  return `${error?.message ?? "unknown error"}${detail}`;
}
if (password.length < 12) {
  console.error("Use a temporary password of at least 12 characters.");
  process.exit(2);
}

const admin = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

const { count, error: countError } = await admin
  .from("dashboard_users")
  .select("id", { count: "exact", head: true })
  .eq("role", "owner");
if (countError) {
  console.error(`Could not check for existing owners: ${describe(countError)}`);
  console.error(`Tried: ${new URL(url).origin}`);
  if (/fetch failed/i.test(countError.message)) {
    console.error(
      "That host could not be reached. Check SUPABASE_URL against Project Settings, API in the Supabase dashboard."
    );
  }
  process.exit(1);
}
if (count && count > 0) {
  console.error("An owner already exists. Add other users from the Users page.");
  process.exit(1);
}

const { data, error } = await admin.auth.admin.createUser({
  email: email.trim().toLowerCase(),
  password,
  email_confirm: true,
});
if (error || !data.user) {
  console.error(`Could not create the login: ${describe(error)}`);
  process.exit(1);
}

const { error: insertError } = await admin
  .from("dashboard_users")
  .insert({ id: data.user.id, email: data.user.email, role: "owner" });
if (insertError) {
  await admin.auth.admin.deleteUser(data.user.id);
  console.error(`Could not add the owner: ${insertError.message}`);
  process.exit(1);
}

const { error: auditError } = await admin.from("audit_log").insert({
  actor_id: data.user.id,
  actor_email: data.user.email,
  role: "owner",
  action: "user.bootstrap_owner",
  details: { email: data.user.email },
});
if (auditError) console.error(`Owner created, but the audit row failed: ${auditError.message}`);

console.log(`Owner created: ${data.user.email}. Sign in, then set up 2FA.`);
