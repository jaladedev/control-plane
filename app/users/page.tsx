import { requirePage } from "@/lib/auth/guards";
import { createClient } from "@/lib/supabase/server";
import { ROLES, ROLE_LABELS } from "@/lib/roles";
import { createUserAction, setActiveAction, setRoleAction } from "@/app/users/actions";

const OK: Record<string, string> = {
  created: "User created. Give them the temporary password; they set up 2FA at first sign-in.",
  role: "Role changed.",
  active: "User updated.",
};

export default async function UsersPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  const actor = await requirePage(["owner"]);
  const { ok, error } = await searchParams;

  const supabase = await createClient();
  const { data: users } = await supabase
    .from("dashboard_users")
    .select("id, email, role, is_active, created_at")
    .order("created_at");

  return (
    <div className="space-y-8">
      <h1 className="text-xl font-semibold">Users</h1>
      {ok && OK[ok] && <p className="rounded bg-green-50 p-3 text-sm text-green-800">{OK[ok]}</p>}
      {error && (
        <p role="alert" className="rounded bg-red-50 p-3 text-sm text-red-800">
          {error}
        </p>
      )}

      <div className="overflow-x-auto rounded border border-slate-200 bg-white">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-slate-200 bg-slate-50 text-slate-600">
            <tr>
              <th className="px-3 py-2">Email</th>
              <th className="px-3 py-2">Role</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {users?.map((u) => (
              <tr key={u.id} className="border-b border-slate-100 last:border-0">
                <td className="px-3 py-2">
                  {u.email}
                  {u.id === actor.id && <span className="ml-2 text-xs text-slate-500">(you)</span>}
                </td>
                <td className="px-3 py-2">
                  <form action={setRoleAction} className="flex gap-2">
                    <input type="hidden" name="userId" value={u.id} />
                    <select
                      name="role"
                      defaultValue={u.role}
                      className="rounded border border-slate-300 px-1 py-0.5"
                    >
                      {ROLES.map((r) => (
                        <option key={r} value={r}>
                          {ROLE_LABELS[r]}
                        </option>
                      ))}
                    </select>
                    <button className="rounded border border-slate-300 px-2 py-0.5 hover:bg-slate-100">
                      Change
                    </button>
                  </form>
                </td>
                <td className="px-3 py-2">{u.is_active ? "Active" : "Deactivated"}</td>
                <td className="px-3 py-2">
                  <form action={setActiveAction}>
                    <input type="hidden" name="userId" value={u.id} />
                    <input type="hidden" name="active" value={u.is_active ? "false" : "true"} />
                    <button className="rounded border border-slate-300 px-2 py-0.5 hover:bg-slate-100">
                      {u.is_active ? "Deactivate" : "Reactivate"}
                    </button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <form
        action={createUserAction}
        className="max-w-md space-y-3 rounded border border-slate-200 bg-white p-4"
      >
        <h2 className="font-medium">Add a user</h2>
        <label className="block text-sm">
          Email
          <input
            name="email"
            type="email"
            required
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1"
          />
        </label>
        <label className="block text-sm">
          Role
          <select
            name="role"
            defaultValue="support"
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1"
          >
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABELS[r]}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm">
          Temporary password (at least 12 characters)
          <input
            name="password"
            type="text"
            minLength={12}
            required
            autoComplete="off"
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1"
          />
        </label>
        <button className="rounded bg-slate-900 px-3 py-2 text-sm text-white hover:bg-slate-700">
          Create user
        </button>
      </form>
    </div>
  );
}
