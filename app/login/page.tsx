import { signInAction } from "@/app/actions";

const MESSAGES: Record<string, string> = {
  invalid: "That email and password did not work.",
  "no-access": "This account does not have access to the control plane.",
  unavailable:
    "Could not reach the sign-in service. Check that SUPABASE_URL in .env.local is this project's real URL, then try again.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  return (
    <div className="mx-auto mt-16 max-w-sm rounded border border-slate-200 bg-white p-6">
      <h1 className="mb-4 text-lg font-semibold">Sign in</h1>
      {error && MESSAGES[error] && (
        <p role="alert" className="mb-3 text-sm text-red-700">
          {MESSAGES[error]}
        </p>
      )}
      <form action={signInAction} className="space-y-3">
        <label className="block text-sm">
          Email
          <input
            name="email"
            type="email"
            autoComplete="username"
            required
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1"
          />
        </label>
        <label className="block text-sm">
          Password
          <input
            name="password"
            type="password"
            autoComplete="current-password"
            required
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1"
          />
        </label>
        <button className="w-full rounded bg-slate-900 px-3 py-2 text-sm text-white hover:bg-slate-700">
          Continue
        </button>
      </form>
      <p className="mt-4 text-xs text-slate-500">
        Two-factor sign-in is required for every account.
      </p>
    </div>
  );
}
