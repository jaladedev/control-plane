import { requirePage } from "@/lib/auth/guards";
import { createClient } from "@/lib/supabase/server";
import { formatNaira } from "@/lib/billing/money";
import { priceAt, itemLabel, type PriceRow } from "@/lib/billing/quote";
import { setOverrideAction, setPriceAction } from "../billing/actions";

// The price catalog. Prices are never edited: a change is a new entry with a
// start date and a reason, and it applies to new quotes only; invoices already
// made keep the prices they were made with. Owner and finance can look; only the
// owner can change anything.

const OK: Record<string, string> = {
  price_set: "Price saved. It applies to new quotes from its start date.",
  override_set: "Override saved. It applies to new quotes for that school and session.",
};
const field = "rounded border border-slate-300 px-2 py-1 text-sm";
const ITEMS = [
  ["base_fee", "Base fee (per session)"],
  ["included_students", "Students included in the base fee"],
  ["extra_student", "Each extra student"],
  ["pro_hosting", "Pro hosting"],
  ["feature", "An add-on (name it below)"],
] as const;

const show = (p: PriceRow) =>
  p.item === "included_students" ? `${p.count} students` : formatNaira(p.amount_kobo ?? 0);

export default async function PricesPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  const actor = await requirePage(["owner", "finance"]);
  const isOwner = actor.role === "owner";
  const { ok, error } = await searchParams;
  const supabase = await createClient();
  const [pricesRes, overridesRes, schoolsRes] = await Promise.all([
    supabase
      .from("price_catalog")
      .select("id, item, amount_kobo, count, effective_from, created_at, reason, set_by")
      .order("created_at", { ascending: false }),
    supabase
      .from("school_price_overrides")
      .select("id, school_id, item, session, amount_kobo, percent_off, reason, set_by, created_at")
      .order("created_at", { ascending: false })
      .limit(30),
    supabase.from("schools").select("id, slug, name").order("slug"),
  ]);
  const prices = (pricesRes.data ?? []) as (PriceRow & {
    id: string;
    reason: string;
    set_by: string;
  })[];
  const now = new Date();
  const items = [...new Set(prices.map((p) => p.item))].sort();
  const names = new Map((schoolsRes.data ?? []).map((s) => [s.id as string, s.name as string]));

  return (
    <div className="space-y-8">
      <h1 className="text-xl font-semibold">Prices</h1>
      {ok && OK[ok] && <p className="rounded bg-green-50 p-3 text-sm text-green-800">{OK[ok]}</p>}
      {error && <p className="rounded bg-red-50 p-3 text-sm text-red-800">{error}</p>}

      <section className="space-y-3">
        <h2 className="font-semibold">In force now</h2>
        {items.length === 0 ? (
          <p className="text-sm text-slate-600">
            No prices set yet. Nothing can be invoiced until at least the base fee and the student
            allowance are set.
          </p>
        ) : (
          <table className="w-full max-w-xl text-left text-sm">
            <tbody>
              {items.map((item) => {
                const p = priceAt(prices, item, now);
                const upcoming = prices.filter(
                  (x) => x.item === item && Date.parse(x.effective_from) > now.getTime()
                );
                return (
                  <tr key={item} className="border-b border-slate-100">
                    <td className="py-1.5">{itemLabel(item)}</td>
                    <td className="py-1.5 font-medium">{p ? show(p) : "not yet in force"}</td>
                    <td className="py-1.5 text-xs text-slate-500">
                      {upcoming
                        .map((u) => `${show(u)} from ${u.effective_from.slice(0, 10)}`)
                        .join("; ")}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      {isOwner && (
        <section className="space-y-3">
          <h2 className="font-semibold">Set a price</h2>
          <form
            action={setPriceAction}
            className="space-y-3 rounded border border-slate-200 bg-white p-4 text-sm"
          >
            <div className="flex flex-wrap items-end gap-3">
              <label className="block">
                <span className="mb-1 block text-slate-700">Item</span>
                <select name="item" className={field} defaultValue="base_fee">
                  {ITEMS.map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-slate-700">Add-on name</span>
                <input name="feature" placeholder="sms_alerts" className={`${field} w-36`} />
              </label>
              <label className="block">
                <span className="mb-1 block text-slate-700">
                  New value (₦, or a number of students)
                </span>
                <input name="value" autoComplete="off" className={`${field} w-40`} />
              </label>
              <label className="block">
                <span className="mb-1 block text-slate-700">Starts (blank = now)</span>
                <input name="effectiveFrom" type="date" className={field} />
              </label>
            </div>
            <div className="flex flex-wrap items-end gap-3">
              <label className="block">
                <span className="mb-1 block text-slate-700">Reason</span>
                <input name="reason" autoComplete="off" className={`${field} w-72`} />
              </label>
              <label className="block">
                <span className="mb-1 block text-slate-700">
                  Type CHANGE if it moves the price by more than 25%
                </span>
                <input name="confirm" autoComplete="off" className={`${field} w-32`} />
              </label>
              <button className="rounded bg-slate-900 px-4 py-1.5 text-white hover:bg-slate-700">
                Save price
              </button>
            </div>
          </form>

          <h2 className="pt-2 font-semibold">Give one school a different price</h2>
          <form
            action={setOverrideAction}
            className="space-y-3 rounded border border-slate-200 bg-white p-4 text-sm"
          >
            <div className="flex flex-wrap items-end gap-3">
              <label className="block">
                <span className="mb-1 block text-slate-700">School</span>
                <select name="schoolId" className={field} defaultValue="">
                  <option value="" disabled>
                    Choose
                  </option>
                  {(schoolsRes.data ?? []).map((s) => (
                    <option key={s.id as string} value={s.id as string}>
                      {s.slug as string}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-slate-700">Session</span>
                <input name="session" placeholder="2026/2027" className={`${field} w-32`} />
              </label>
              <label className="block">
                <span className="mb-1 block text-slate-700">Item</span>
                <select name="item" className={field} defaultValue="base_fee">
                  {ITEMS.filter(([v]) => v !== "included_students").map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-slate-700">Add-on name</span>
                <input name="feature" placeholder="sms_alerts" className={`${field} w-32`} />
              </label>
            </div>
            <div className="flex flex-wrap items-end gap-3">
              <label className="block">
                <span className="mb-1 block text-slate-700">Kind</span>
                <select name="kind" className={field} defaultValue="percent">
                  <option value="percent">Percent off</option>
                  <option value="amount">Fixed price (₦)</option>
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-slate-700">Value</span>
                <input name="value" autoComplete="off" className={`${field} w-32`} />
              </label>
              <label className="block">
                <span className="mb-1 block text-slate-700">Reason</span>
                <input name="reason" autoComplete="off" className={`${field} w-72`} />
              </label>
              <button className="rounded bg-slate-900 px-4 py-1.5 text-white hover:bg-slate-700">
                Save override
              </button>
            </div>
          </form>
        </section>
      )}

      <section className="space-y-3">
        <h2 className="font-semibold">Overrides</h2>
        {(overridesRes.data ?? []).length === 0 ? (
          <p className="text-sm text-slate-600">None.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {(overridesRes.data ?? []).map((o) => (
              <li key={o.id as string}>
                <strong>{names.get(o.school_id as string) ?? "?"}</strong>, {o.session as string},{" "}
                {itemLabel(o.item as string)}:{" "}
                {o.percent_off !== null
                  ? `${o.percent_off as number}% off`
                  : formatNaira(Number(o.amount_kobo))}{" "}
                <span className="text-slate-500">
                  ({o.reason as string}, by {o.set_by as string})
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="font-semibold">History</h2>
        <ul className="space-y-1 text-sm">
          {prices.slice(0, 40).map((p) => (
            <li key={p.id}>
              {itemLabel(p.item)}: <strong>{show(p)}</strong> from {p.effective_from.slice(0, 10)}{" "}
              <span className="text-slate-500">
                ({p.reason}, by {p.set_by})
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
