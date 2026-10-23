import { requirePage } from "@/lib/auth/guards";
import { createClient } from "@/lib/supabase/server";

// The schools registry. M0 shows the table and its empty state; health,
// licence state and counts arrive with M1.
export default async function SchoolsPage() {
  await requirePage();
  const supabase = await createClient();
  const { data: schools, error } = await supabase
    .from("schools")
    .select(
      "id, slug, name, status, hostnames, hosting_plan, app_version, schema_version, included_students"
    )
    .order("name");

  return (
    <div>
      <h1 className="mb-4 text-xl font-semibold">Schools</h1>
      {error && (
        <p className="mb-4 text-sm text-red-700">Could not load schools: {error.message}</p>
      )}
      {!schools?.length ? (
        <p className="rounded border border-dashed border-slate-300 bg-white p-6 text-sm text-slate-600">
          No schools yet. Schools appear here once they are registered.
        </p>
      ) : (
        <div className="overflow-x-auto rounded border border-slate-200 bg-white">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-slate-600">
              <tr>
                <th className="px-3 py-2">Name</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Hostname</th>
                <th className="px-3 py-2">Plan</th>
                <th className="px-3 py-2">Students</th>
                <th className="px-3 py-2">App</th>
                <th className="px-3 py-2">Schema</th>
              </tr>
            </thead>
            <tbody>
              {schools.map((s) => (
                <tr key={s.id} className="border-b border-slate-100 last:border-0">
                  <td className="px-3 py-2 font-medium">{s.name}</td>
                  <td className="px-3 py-2">{s.status}</td>
                  <td className="px-3 py-2">{s.hostnames?.[0] ?? "—"}</td>
                  <td className="px-3 py-2">{s.hosting_plan}</td>
                  <td className="px-3 py-2">{s.included_students}</td>
                  <td className="px-3 py-2">{s.app_version ?? "—"}</td>
                  <td className="px-3 py-2">{s.schema_version ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
