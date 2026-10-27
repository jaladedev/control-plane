import Link from "next/link";
import { requirePage } from "@/lib/auth/guards";
import { createClient } from "@/lib/supabase/server";
import { previewInvoice, type InvoicePlan } from "@/lib/actions/billing";
import { formatNaira } from "@/lib/billing/money";
import { createInvoiceAction } from "../actions";

// Quote, then invoice. The first form only previews (a GET, so nothing is saved).
// The preview shows every line with the price used and any override. "Create
// invoice" saves exactly that quote: the invoice keeps those prices even if the
// catalog changes later.

const field = "rounded border border-slate-300 px-2 py-1 text-sm";
type Params = Record<string, string | undefined>;

export default async function NewInvoicePage({ searchParams }: { searchParams: Promise<Params> }) {
  await requirePage(["owner", "finance"]);
  const p = await searchParams;
  const supabase = await createClient();
  const { data: schools } = await supabase
    .from("schools")
    .select("id, slug, name, hosting_plan")
    .eq("status", "active")
    .order("slug");

  const wanted = Boolean(p.schoolId && p.session && p.validUntil);
  let plan: InvoicePlan | null = null;
  let problem: string | null = null;
  if (wanted) {
    try {
      plan = await previewInvoice(p);
    } catch (e) {
      problem = e instanceof Error ? e.message : "Could not prepare that quote.";
    }
  }
  const chosen = (schools ?? []).find((s) => s.id === p.schoolId);
  const proDefault =
    p.proHosting !== undefined ? p.proHosting === "on" : chosen?.hosting_plan === "pro";

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/billing" className="text-sm text-blue-700 hover:underline">
          ← Billing
        </Link>
        <h1 className="text-xl font-semibold">New invoice</h1>
      </div>

      <form method="get" className="space-y-3 rounded border border-slate-200 bg-white p-4 text-sm">
        <div className="flex flex-wrap items-end gap-3">
          <label className="block">
            <span className="mb-1 block text-slate-700">School</span>
            <select name="schoolId" defaultValue={p.schoolId ?? ""} className={field}>
              <option value="" disabled>
                Choose
              </option>
              {(schools ?? []).map((s) => (
                <option key={s.id as string} value={s.id as string}>
                  {s.name as string} ({s.slug as string})
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-slate-700">Session</span>
            <input
              name="session"
              defaultValue={p.session ?? ""}
              placeholder="2026/2027"
              className={`${field} w-32`}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-slate-700">Licence valid until</span>
            <input
              name="validUntil"
              type="date"
              defaultValue={p.validUntil ?? ""}
              className={field}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-slate-700">Grace days</span>
            <input
              name="graceDays"
              type="number"
              min={0}
              max={180}
              defaultValue={p.graceDays ?? "14"}
              className={`${field} w-24`}
            />
          </label>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <label className="block">
            <span className="mb-1 block text-slate-700">Extra students above the allowance</span>
            <input
              name="extraStudents"
              type="number"
              min={0}
              defaultValue={p.extraStudents ?? "0"}
              className={`${field} w-28`}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-slate-700">Add-ons (comma separated)</span>
            <input
              name="features"
              defaultValue={p.features ?? ""}
              placeholder="sms_alerts, parent_app"
              className={`${field} w-64`}
            />
          </label>
          <label className="flex items-center gap-2 pb-1">
            <input type="checkbox" name="proHosting" defaultChecked={proDefault} /> Pro hosting
          </label>
          <button className="rounded border border-slate-300 px-4 py-1.5 hover:bg-slate-50">
            Preview quote
          </button>
        </div>
      </form>

      {problem && <p className="rounded bg-red-50 p-3 text-sm text-red-800">{problem}</p>}

      {plan && (
        <section className="space-y-3 rounded border border-slate-200 bg-white p-4 text-sm">
          <h2 className="font-semibold">
            {plan.school.name}, {plan.quote.session}
          </h2>
          <table className="w-full text-left">
            <thead className="border-b border-slate-200 text-slate-600">
              <tr>
                <th className="py-1">Line</th>
                <th className="py-1">Qty</th>
                <th className="py-1">Unit</th>
                <th className="py-1 text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              {plan.quote.lines.map((l) => (
                <tr key={l.item} className="border-b border-slate-100">
                  <td className="py-1">
                    {l.label}
                    {l.override && (
                      <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800">
                        override:{" "}
                        {l.override.kind === "percent" ? `${l.override.value}% off` : "fixed price"}{" "}
                        ({l.override.reason})
                      </span>
                    )}
                  </td>
                  <td className="py-1">{l.quantity}</td>
                  <td className="py-1">
                    {formatNaira(l.unit_kobo)}
                    {l.override && (
                      <span className="text-xs text-slate-500">
                        {" "}
                        (list {formatNaira(l.list_unit_kobo)})
                      </span>
                    )}
                  </td>
                  <td className="py-1 text-right">{formatNaira(l.total_kobo)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={3} className="py-2 font-semibold">
                  Total
                </td>
                <td className="py-2 text-right text-lg font-semibold">
                  {formatNaira(plan.quote.total_kobo)}
                </td>
              </tr>
            </tfoot>
          </table>
          <p className="text-slate-600">
            Allowance {plan.quote.included_students} students
            {plan.quote.extra_students > 0 ? ` plus ${plan.quote.extra_students} extra` : ""}.
            Licence valid until {plan.validUntil.toISOString().slice(0, 10)}, grace until{" "}
            {plan.graceUntil.toISOString().slice(0, 10)}.
          </p>
          <form action={createInvoiceAction} className="flex items-center gap-3">
            {Object.entries(p).map(([k, v]) =>
              v === undefined ? null : <input key={k} type="hidden" name={k} value={v} />
            )}
            <button className="rounded bg-slate-900 px-4 py-1.5 text-white hover:bg-slate-700">
              Create invoice
            </button>
            <span className="text-slate-600">
              The school pays against the reference this creates.
            </span>
          </form>
        </section>
      )}
    </div>
  );
}
