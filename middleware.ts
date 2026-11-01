import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { decideAccess, isPublicPath, type Aal } from "@/lib/access";
import { AccessKeys, accessConfigFromEnv, accessGate, type AccessConfig } from "@/lib/cf-access";

// Cloudflare Access is checked first when it is configured (lib/cf-access.ts): a request
// without Cloudflare's signed token never gets as far as the app's own login.
//
// Runs on every page request. Refreshes the session, then applies the access
// rules in lib/access.ts: signed out goes to /login, a password-only session
// goes to /mfa, and a signed-in account that is no longer an active dashboard
// user is signed out. The same rules are enforced again in the database (row-
// level security needs aal2) and in lib/auth/guards.ts, so this is the first
// door, not the only one.
let cloudflare: { config: AccessConfig | null; keys: AccessKeys | null } | null = null;
function cloudflareAccess() {
  if (!cloudflare) {
    const config = accessConfigFromEnv();
    cloudflare = { config, keys: config ? new AccessKeys(config.issuer) : null };
  }
  return cloudflare;
}

export async function middleware(request: NextRequest) {
  let gate;
  try {
    const { config, keys } = cloudflareAccess();
    gate = await accessGate(
      { path: request.nextUrl.pathname, token: request.headers.get("cf-access-jwt-assertion") },
      config,
      keys
    );
  } catch (error) {
    // Half-set or malformed settings: refuse everything rather than run without the check.
    console.error(error instanceof Error ? error.message : error);
    return new NextResponse("The Cloudflare Access settings are wrong. See the server log.", {
      status: 500,
      headers: { "content-type": "text/plain" },
    });
  }
  if (!gate.allow) {
    return new NextResponse(gate.message, {
      status: gate.status,
      headers: { "content-type": "text/plain", "cache-control": "no-store" },
    });
  }

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
  if (signedIn && aal === "aal2" && !isPublicPath(path)) {
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
