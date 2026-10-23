#!/usr/bin/env node
/**
 * Creates the first owner. Run once, after the migration, from a trusted
 * machine, with the project's URL and service-role key in the environment:
 *
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *     node scripts/create-owner.mjs you@example.com 'a-long-temporary-password'
 *
 * It refuses to run if an owner already exists (add further users from the
 * Users page). The owner enrols an authenticator app at first sign-in. Turn
 * off "Allow new users to sign up" in the Supabase dashboard (Authentication,
 * Sign In / Providers) so only people added here can ever have a login.
 */
import { createClient } from "@supabase/supabase-js";

const [email, password] = process.argv.slice(2);
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!email || !password || !url || !key) {
  console.error(
    "Usage: SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/create-owner.mjs <email> <password>"
  );
  process.exit(2);
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
  console.error(`Could not check for existing owners: ${countError.message}`);
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
  console.error(`Could not create the login: ${error?.message ?? "unknown error"}`);
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
