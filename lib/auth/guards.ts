import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isRole, type Role } from "@/lib/roles";

// Who is asking, and are they allowed. Every server action and every page that
// shows data goes through requireActor / requirePage, so there is one place
// that decides. An actor is only ever someone who:
//   1. has a verified Supabase session (getUser, not just a cookie),
//   2. has passed 2FA (aal2), and
//   3. is an active row in dashboard_users (the database says so, not the JWT).

export type Actor = { id: string; email: string; role: Role };

export class AccessError extends Error {
  constructor(
    message: string,
    readonly code: "signed_out" | "needs_2fa" | "no_access" | "forbidden"
  ) {
    super(message);
    this.name = "AccessError";
  }
}

/** The current actor, or why there is none. */
export async function resolveActor(): Promise<
  { actor: Actor } | { error: "signed_out" | "needs_2fa" | "no_access" }
> {
  const supabase = await createClient();

  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return { error: "signed_out" };

  const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (aal?.currentLevel !== "aal2") return { error: "needs_2fa" };

  const { data: role, error: roleError } = await supabase.rpc("dashboard_role");
  if (roleError || !isRole(role)) return { error: "no_access" };

  return { actor: { id: data.user.id, email: data.user.email ?? "", role } };
}

/** For server actions: the actor, or an AccessError. `allowed` limits the roles. */
export async function requireActor(allowed?: readonly Role[]): Promise<Actor> {
  const result = await resolveActor();
  if ("error" in result) {
    const messages = {
      signed_out: "You are signed out.",
      needs_2fa: "Finish two-factor sign-in first.",
      no_access: "This account does not have access.",
    } as const;
    throw new AccessError(messages[result.error], result.error);
  }
  if (allowed && !allowed.includes(result.actor.role)) {
    throw new AccessError("Your role cannot do this.", "forbidden");
  }
  return result.actor;
}

/** For pages: the actor, or a redirect to wherever they should be instead. */
export async function requirePage(allowed?: readonly Role[]): Promise<Actor> {
  const result = await resolveActor();
  if ("error" in result) {
    redirect(result.error === "needs_2fa" ? "/mfa" : "/login");
  }
  if (allowed && !allowed.includes(result.actor.role)) redirect("/");
  return result.actor;
}
