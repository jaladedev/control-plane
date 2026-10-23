import { isAuthRetryableFetchError } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAudit } from "@/lib/audit";

// Sign-in steps. Returns a short reason code instead of throwing, so the
// pages can redirect with a message. Every outcome is audited, but on a
// best-effort basis: these entries record what happened, they are not a write
// that needs approving, and a sign-in problem (for example Supabase being
// unreachable) must show a message, not crash the page. Actions that change
// data use withAudit() instead, which refuses to run without its audit row.

async function recordAuth(
  who: Parameters<typeof writeAudit>[0],
  entry: Parameters<typeof writeAudit>[1]
): Promise<void> {
  try {
    await writeAudit(who, entry);
  } catch (error) {
    console.error(`[audit] could not record ${entry.action}:`, error);
  }
}

export type SignInResult =
  { ok: true; next: "/" | "/mfa" } | { ok: false; reason: "invalid" | "no-access" | "unavailable" };

export async function signInWithPassword(email: string, password: string): Promise<SignInResult> {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });

  if (error || !data.user) {
    // A network or server problem is not a wrong password: say so, and don't
    // log it as a failed attempt by this person.
    if (error && (isAuthRetryableFetchError(error) || (error.status ?? 0) >= 500)) {
      console.error("[auth] could not reach Supabase to sign in:", error.message);
      return { ok: false, reason: "unavailable" };
    }
    await recordAuth({ email }, { action: "auth.login_failed", details: { email } });
    return { ok: false, reason: "invalid" };
  }

  // Only people on the dashboard_users list may continue, whatever else exists
  // in this Supabase project's auth users.
  const { data: row, error: rowError } = await createAdminClient()
    .from("dashboard_users")
    .select("is_active")
    .eq("id", data.user.id)
    .maybeSingle();
  if (rowError) {
    console.error("[auth] could not check dashboard_users:", rowError.message);
    await supabase.auth.signOut();
    return { ok: false, reason: "unavailable" };
  }
  if (!row?.is_active) {
    await supabase.auth.signOut();
    await recordAuth({ email }, { action: "auth.login_refused", details: { email } });
    return { ok: false, reason: "no-access" };
  }

  const { data: level } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  return { ok: true, next: level?.currentLevel === "aal2" ? "/" : "/mfa" };
}

/** Confirms a new authenticator app with its first code. */
export async function verifyEnrolment(factorId: string, code: string): Promise<boolean> {
  const supabase = await createClient();
  const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code });
  if (error) return false;
  const { data } = await supabase.auth.getUser();
  await recordAuth(
    { id: data.user?.id, email: data.user?.email ?? undefined },
    { action: "auth.mfa_enrolled" }
  );
  return true;
}

/** Completes sign-in with a code from the existing authenticator app. */
export async function verifyChallenge(factorId: string, code: string): Promise<boolean> {
  const supabase = await createClient();
  const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code });
  const { data } = await supabase.auth.getUser();
  const who = { id: data.user?.id, email: data.user?.email ?? undefined };
  await recordAuth(who, { action: error ? "auth.mfa_failed" : "auth.login" });
  return !error;
}

export async function signOutCurrent(): Promise<void> {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (data.user) {
    await recordAuth(
      { id: data.user.id, email: data.user.email ?? undefined },
      { action: "auth.logout" }
    );
  }
  await supabase.auth.signOut();
}
