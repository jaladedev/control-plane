// Which pages a visitor may reach, decided from two facts: whether they are
// signed in, and whether the session has passed 2FA (Supabase's "aal2").
// Pure, so it is easy to test; middleware.ts supplies the facts.

export type Aal = "aal1" | "aal2" | null;

export type Decision = { action: "allow" } | { action: "redirect"; to: string };

// /api/cron/health has no session; it checks its own bearer secret.
const ALWAYS_PUBLIC = ["/api/health", "/api/cron/health"];

export function decideAccess(input: { path: string; signedIn: boolean; aal: Aal }): Decision {
  const { path, signedIn, aal } = input;

  if (ALWAYS_PUBLIC.includes(path)) return { action: "allow" };

  if (!signedIn) {
    return path === "/login" ? { action: "allow" } : { action: "redirect", to: "/login" };
  }

  if (aal !== "aal2") {
    // Password only: the only place to go is the 2FA step (enrol or enter a code).
    return path === "/mfa" ? { action: "allow" } : { action: "redirect", to: "/mfa" };
  }

  // Fully signed in: the login and 2FA pages have nothing left to do.
  if (path === "/login" || path === "/mfa") return { action: "redirect", to: "/" };
  return { action: "allow" };
}
