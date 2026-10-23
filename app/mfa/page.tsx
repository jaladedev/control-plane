import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { loadMfaState } from "@/lib/auth/mfa";
import { verifyMfaAction } from "@/app/actions";

export const dynamic = "force-dynamic";

export default async function MfaPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;

  // Middleware already sends signed-out visitors away; this guards direct hits.
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) redirect("/login");

  const state = await loadMfaState();

  return (
    <div className="mx-auto mt-16 max-w-sm rounded border border-slate-200 bg-white p-6">
      <h1 className="mb-2 text-lg font-semibold">
        {state.mode === "enrol" ? "Set up two-factor sign-in" : "Enter your code"}
      </h1>
      {state.mode === "enrol" ? (
        <div className="mb-4 space-y-3 text-sm text-slate-700">
          <p>
            Scan this with an authenticator app (such as Google Authenticator, 1Password or Authy),
            then enter the 6-digit code it shows.
          </p>
          {/* The QR code is an SVG data URL from Supabase. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={state.qrCode}
            alt="QR code for your authenticator app"
            className="mx-auto h-44 w-44"
          />
          <p className="break-all text-xs text-slate-500">
            Can&apos;t scan? Enter this key instead: <code>{state.secret}</code>
          </p>
        </div>
      ) : (
        <p className="mb-4 text-sm text-slate-700">
          Open your authenticator app and enter the 6-digit code.
        </p>
      )}
      {error === "code" && (
        <p role="alert" className="mb-3 text-sm text-red-700">
          That code did not work. Try the next one.
        </p>
      )}
      <form action={verifyMfaAction} className="space-y-3">
        <input type="hidden" name="factorId" value={state.factorId} />
        <input type="hidden" name="mode" value={state.mode} />
        <input
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9 ]{6,7}"
          maxLength={7}
          required
          autoFocus
          className="w-full rounded border border-slate-300 px-2 py-1 tracking-widest"
        />
        <button className="w-full rounded bg-slate-900 px-3 py-2 text-sm text-white hover:bg-slate-700">
          Verify
        </button>
      </form>
    </div>
  );
}
