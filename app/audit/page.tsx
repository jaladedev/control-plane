import { requirePage } from "@/lib/auth/guards";
import { createClient } from "@/lib/supabase/server";

// Read-only view of the most recent audit entries (owner only). Filters by
// actor, school, action and date arrive with M7.
export default async function AuditPage() {
  await requirePage(["owner"]);
  const supabase = await createClient();
  const { data: rows, error } = await supabase
    .from("audit_log")
    .select("id, at, actor_email, role, action, school_id, details, ip")
    .order("id", { ascending: false })
    .limit(200);

  return (
    <div>
      <h1 className="mb-4 text-xl font-semibold">Audit log</h1>
      {error && (
        <p className="mb-4 text-sm text-red-700">Could not load the log: {error.message}</p>
      )}
      <div className="overflow-x-auto rounded border border-slate-200 bg-white">
        <table className="w-full text-left text-xs">
          <thead className="border-b border-slate-200 bg-slate-50 text-slate-600">
            <tr>
              <th className="px-3 py-2">When</th>
              <th className="px-3 py-2">Who</th>
              <th className="px-3 py-2">Action</th>
              <th className="px-3 py-2">Details</th>
              <th className="px-3 py-2">IP</th>
            </tr>
          </thead>
          <tbody>
            {rows?.map((r) => (
              <tr key={r.id} className="border-b border-slate-100 align-top last:border-0">
                <td className="whitespace-nowrap px-3 py-2">
                  {new Date(r.at).toISOString().replace("T", " ").slice(0, 19)}
                </td>
                <td className="px-3 py-2">
                  {r.actor_email ?? "—"}
                  {r.role ? ` (${r.role})` : ""}
                </td>
                <td className="px-3 py-2 font-mono">{r.action}</td>
                <td className="px-3 py-2 font-mono text-slate-600">{JSON.stringify(r.details)}</td>
                <td className="px-3 py-2">{r.ip ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
