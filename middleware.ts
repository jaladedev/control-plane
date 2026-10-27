import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { decideAccess, type Aal } from "@/lib/access";

// Runs on every page request. Refreshes the session, then applies the access
// rules in lib/access.ts: signed out goes to /login, a password-only session
// goes to /mfa, and a signed-in account that is no longer an active dashboard
// user is signed out. The same rules are enforced again in the database (row-
// level security needs aal2) and in lib/auth/guards.ts, so this is the first
// door, not the only one.
export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (toSet) => {
        toSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        toSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      },
    },
  });

  const path = request.nextUrl.pathname;
  const { data } = await supabase.auth.getUser();
  const signedIn = !!data.user;

  let aal: Aal = null;
  if (signedIn) {
    const { data: level } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    aal = (level?.currentLevel as Aal) ?? null;
  }

  // A fully signed-in session for someone who is no longer an active dashboard
  // user (deactivated, or never one): end it.
  if (
    signedIn &&
    aal === "aal2" &&
    path !== "/api/health" &&
    path !== "/api/cron/health" &&
    path !== "/api/claims"
  ) {
    const { data: role } = await supabase.rpc("dashboard_role");
    if (!role) {
      await supabase.auth.signOut();
      const redirect = NextResponse.redirect(new URL("/login?error=no-access", request.url));
      for (const cookie of request.cookies.getAll()) {
        if (cookie.name.startsWith("sb-")) {
          redirect.cookies.set({ name: cookie.name, value: "", maxAge: 0, path: "/" });
        }
      }
      return redirect;
    }
  }

  const decision = decideAccess({ path, signedIn, aal });
  if (decision.action === "redirect") {
    return NextResponse.redirect(new URL(decision.to, request.url));
  }
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
