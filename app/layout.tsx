import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";
import { resolveActor } from "@/lib/auth/guards";
import { ROLE_LABELS } from "@/lib/roles";
import { signOutAction } from "@/app/actions";

export const metadata: Metadata = {
  title: "Control plane",
  robots: { index: false, follow: false },
};
export const dynamic = "force-dynamic";

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const result = await resolveActor();
  const actor = "actor" in result ? result.actor : null;

  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-50 text-slate-900">
        {actor && (
          <header className="border-b border-slate-200 bg-white">
            <nav className="mx-auto flex max-w-6xl items-center gap-6 px-4 py-3 text-sm">
              <span className="font-semibold">Control plane</span>
              <Link href="/" className="hover:underline">
                Schools
              </Link>
              <Link href="/migrations" className="hover:underline">
                Migrations
              </Link>
              {(actor.role === "owner" || actor.role === "finance") && (
                <>
                  <Link href="/billing" className="hover:underline">
                    Billing
                  </Link>
                  <Link href="/prices" className="hover:underline">
                    Prices
                  </Link>
                </>
              )}
              {actor.role === "owner" && (
                <>
                  <Link href="/users" className="hover:underline">
                    Users
                  </Link>
                  <Link href="/audit" className="hover:underline">
                    Audit log
                  </Link>
                </>
              )}
              <span className="ml-auto text-slate-500">
                {actor.email} ({ROLE_LABELS[actor.role]})
              </span>
              <form action={signOutAction}>
                <button className="rounded border border-slate-300 px-3 py-1 hover:bg-slate-100">
                  Sign out
                </button>
              </form>
            </nav>
          </header>
        )}
        <main className="mx-auto max-w-6xl px-4 py-8">{children}</main>
      </body>
    </html>
  );
}
