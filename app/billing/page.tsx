import Link from "next/link";
import { requirePage } from "@/lib/auth/guards";
import { createClient } from "@/lib/supabase/server";
import { formatNaira } from "@/lib/billing/money";
import { ago } from "@/components/badges";
import {
  cancelInvoiceAction,
  cancelTopupAction,
  confirmClaimAction,
  createTopupAction,
  extendInvoiceAction,
  markPaidAction,
  markTopupPaidAction,
  refundInvoiceAction,
  resolvePaystackReviewAction,
  rejectClaimAction,
} from "./actions";

// The Billing queue. Claims waiting for a person to check them against the bank
// statement come first, oldest first, because the oldest is the school that has
// waited longest. A claim pays nothing by itself: only Confirm does, and it asks
// for the amount the bank shows and a reason, which the database checks against
// the invoice.

const OK: Record<string, string> = {
  invoice_created: "Invoice created. Give the school its reference to pay against.",
  invoice_cancelled: "Invoice cancelled.",
  marked_paid: "Marked paid. The school's licence is being updated.",
  extended: "Extended. The school's licence is being updated.",
  claim_confirmed:
    "Claim confirmed and the invoice marked paid. The school's licence is being updated.",
  claim_rejected: "Claim rejected. The invoice is open again.",
  topup_created: "Top-up invoiced. Nothing changes for the school until you mark it paid.",
  topup_cancelled: "Top-up cancelled.",
  topup_paid: "Top-up paid. The school's student allowance is being raised.",
  paystack_resolved: "Card payment marked as dealt with.",
  refunded:
    "Refund recorded and the licence ended. Now send the money back from your bank; this screen does not move money.",
};

// Same window as the database applies (REFUND_WINDOW_DAYS in lib/actions/billing.ts).
const REFUND_DAYS = 14;

const field = "rounded border border-slate-300 px-2 py-1 text-sm";
const STATUS: Record<string, string> = {
  pending: "bg-amber-100 text-amber-800",
  pending_confirmation: "bg-blue-100 text-blue-800",
  paid: "bg-green-100 text-green-800",
  cancelled: "bg-slate-100 text-slate-500",
  refunded: "bg-slate-200 text-slate-700",
  trial: "bg-slate-100 text-slate-600",
};
const label = (s: string) => s.replace("_", " ");
const day = (iso: string) => iso.slice(0, 10);

export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  const actor = await requirePage(["owner", "finance"]);
  const { ok, error } = await searchParams;
  const supabase = await createClient();

  const [claimsRes, subsRes, schoolsRes, decidedRes, topupsRes, reviewsRes] = await Promise.all([
    supabase
      .from("payment_claims")
      .select(
        "id, school_id, subscription_id, amount_kobo, sent_on, sender_name, payer_reference, proof_path, claimed_by, created_at"
      )
      .eq("status", "pending")
      .order("created_at", { ascending: true }),
    supabase
      .from("subscriptions")
      .select(
        "id, school_id, session, reference, amount_kobo, topup_kobo, status, method, paid_at, valid_until, grace_until, created_at, refund_kobo"
      )
      .in("status", ["pending", "pending_confirmation", "paid", "refunded"])
      .order("created_at", { ascending: false })
      .limit(60),
    supabase.from("schools").select("id, slug, name").order("slug"),
    supabase
      .from("payment_claims")
      .select("id, school_id, amount_kobo, status, decided_by, decided_at, decision_reason")
      .neq("status", "pending")
      .order("decided_at", { ascending: false })
      .limit(10),
    supabase
      .from("subscription_topups")
      .select("id, school_id, subscription_id, reference, extra_students, amount_kobo, created_at")
      .eq("status", "pending")
      .order("created_at", { ascending: true }),
    supabase
      .from("paystack_payments")
      .select(
        "id, school_id, subscription_id, reference, amount_kobo, paid_amount_kobo, paid_at, note"
      )
      .eq("status", "needs_review")
      .order("paid_at", { ascending: true }),
  ]);

  const schools = new Map((schoolsRes.data ?? []).map((s) => [s.id as string, s]));
  const nameOf = (id: string) => (schools.get(id)?.name as string | undefined) ?? "?";
  const subs = subsRes.data ?? [];
  const subById = new Map(subs.map((s) => [s.id as string, s]));
  const claims = claimsRes.data ?? [];
  const decided = decidedRes.data ?? [];
  const topups = topupsRes.data ?? [];
  const reviews = reviewsRes.data ?? [];

  return (
    <div className="space-y-8">
      <div className="flex items-center gap-4">
        <h1 className="text-xl font-semibold">Billing</h1>
        <Link
          href="/billing/new"
          className="rounded bg-slate-900 px-3 py-1.5 text-sm text-white hover:bg-slate-700"
        >
          New invoice
        </Link>
      </div>
      {ok && OK[ok] && <p className="rounded bg-green-50 p-3 text-sm text-green-800">{OK[ok]}</p>}
      {error && <p className="rounded bg-red-50 p-3 text-sm text-red-800">{error}</p>}

      <section className="space-y-3">
        <h2 className="font-semibold">Claims waiting ({claims.length})</h2>
        <p className="text-sm text-slate-600">
          A school says it has sent a transfer. Confirm only after you have seen the money in your
          bank statement.
        </p>
        {claims.length === 0 && <p className="text-sm text-slate-600">Nothing waiting.</p>}
        {claims.map((c) => {
          const sub = subById.get(c.subscription_id as string);
          const hours = Math.floor((Date.now() - Date.parse(c.created_at as string)) / 3_600_000);
          return (
            <div
              key={c.id as string}
              className="space-y-3 rounded border border-slate-200 bg-white p-4 text-sm"
            >
              <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                <span className="font-medium">{nameOf(c.school_id as string)}</span>
                <span className="text-lg font-semibold">{formatNaira(Number(c.amount_kobo))}</span>
                <span className="text-slate-600">
                  invoice <code>{sub?.reference as string}</code> · {sub?.session as string} · due{" "}
                  {formatNaira(Number(sub?.amount_kobo ?? 0))}
                </span>
                <span className={hours >= 48 ? "text-red-700" : "text-slate-500"}>
                  waiting {hours < 1 ? "under an hour" : `${hours} h`}
                </span>
              </div>
              <div className="text-slate-600">
                Sent on {c.sent_on as string} by {c.sender_name as string}
                {c.payer_reference ? ` · bank reference ${c.payer_reference as string}` : ""} ·
                claimed by {c.claimed_by as string}
                {c.proof_path ? (
                  <>
                    {" · "}
                    <a
                      href={`/billing/proof/${c.id as string}`}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="text-blue-700 hover:underline"
                    >
                      View proof
                    </a>
                  </>
                ) : (
                  " · no proof attached"
                )}
              </div>
              <div className="flex flex-wrap gap-6">
                <form action={confirmClaimAction} className="flex flex-wrap items-end gap-2">
                  <input type="hidden" name="claimId" value={c.id as string} />
                  <label className="block">
                    <span className="mb-1 block text-slate-700">Amount in your bank (₦)</span>
                    <input
                      name="amount"
                      autoComplete="off"
                      className={`${field} w-36`}
                      placeholder={String(Number(c.amount_kobo) / 100)}
                    />
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-slate-700">What you checked</span>
                    <input
                      name="reason"
                      autoComplete="off"
                      className={`${field} w-56`}
                      placeholder="statement line, date"
                    />
                  </label>
                  <button className="rounded bg-green-700 px-3 py-1.5 text-white hover:bg-green-800">
                    Confirm
                  </button>
                </form>
                <form action={rejectClaimAction} className="flex flex-wrap items-end gap-2">
                  <input type="hidden" name="claimId" value={c.id as string} />
                  <label className="block">
                    <span className="mb-1 block text-slate-700">Why it is rejected</span>
                    <input name="reason" autoComplete="off" className={`${field} w-56`} />
                  </label>
                  <button className="rounded border border-red-300 px-3 py-1.5 text-red-700 hover:bg-red-50">
                    Reject
                  </button>
                </form>
              </div>
            </div>
          );
        })}
      </section>

      {reviews.length > 0 && (
        <section className="space-y-3">
          <h2 className="font-semibold text-red-800">
            Card payments needing review ({reviews.length})
          </h2>
          <p className="text-sm text-slate-600">
            Money reached Paystack that could not be matched to an open invoice for the right
            amount, so nothing was changed for the school. Decide what to do (usually refund it from
            the Paystack dashboard, or pay the right invoice), then record what you did.
          </p>
          {reviews.map((r) => (
            <div
              key={r.id as string}
              className="space-y-2 rounded border border-red-200 bg-red-50 p-4 text-sm"
            >
              <div className="flex flex-wrap gap-x-6 gap-y-1">
                <span className="font-medium">{nameOf(r.school_id as string)}</span>
                <span className="font-mono text-xs">{r.reference as string}</span>
                <span>
                  received {formatNaira(Number(r.paid_amount_kobo ?? 0))}, invoiced{" "}
                  {formatNaira(Number(r.amount_kobo))}
                </span>
                <span className="text-slate-500">{ago(r.paid_at as string)}</span>
              </div>
              <p>{r.note as string}</p>
              <form action={resolvePaystackReviewAction} className="flex flex-wrap items-end gap-2">
                <input type="hidden" name="paymentId" value={r.id as string} />
                <input
                  name="resolution"
                  placeholder="What you did (for example: refunded in Paystack)"
                  className={`${field} w-96`}
                />
                <button className="rounded bg-slate-900 px-3 py-1.5 text-white">
                  Mark dealt with
                </button>
              </form>
            </div>
          ))}
        </section>
      )}

      {topups.length > 0 && (
        <section className="space-y-3">
          <h2 className="font-semibold">Top-ups waiting for payment ({topups.length})</h2>
          <p className="text-sm text-slate-600">
            Extra students on a paid session. Mark one paid only after you have seen the money in
            your bank statement; the school&apos;s allowance goes up then, not before.
          </p>
          {topups.map((t) => (
            <div
              key={t.id as string}
              className="space-y-3 rounded border border-slate-200 bg-white p-4 text-sm"
            >
              <div className="flex flex-wrap gap-x-6 gap-y-1">
                <span className="font-medium">{nameOf(t.school_id as string)}</span>
                <span className="font-mono text-xs">{t.reference as string}</span>
                <span>{t.extra_students as number} extra students</span>
                <span>{formatNaira(Number(t.amount_kobo))}</span>
                <span className="text-slate-500">{ago(t.created_at as string)}</span>
              </div>
              <div className="flex flex-wrap gap-6">
                <form action={markTopupPaidAction} className="flex flex-wrap items-end gap-2">
                  <input type="hidden" name="topupId" value={t.id as string} />
                  <label className="block">
                    <span className="mb-1 block text-slate-700">
                      Amount your bank shows (naira)
                    </span>
                    <input
                      name="amount"
                      inputMode="decimal"
                      autoComplete="off"
                      className={`${field} w-40`}
                    />
                  </label>
                  <input
                    name="paymentRef"
                    placeholder="Bank reference (optional)"
                    className={`${field} w-48`}
                  />
                  <input name="reason" placeholder="What you checked" className={`${field} w-48`} />
                  <button className="rounded bg-green-700 px-3 py-1.5 text-white hover:bg-green-800">
                    Mark paid
                  </button>
                </form>
                <form action={cancelTopupAction} className="flex flex-wrap items-end gap-2">
                  <input type="hidden" name="topupId" value={t.id as string} />
                  <input
                    name="reason"
                    placeholder="Why it is cancelled"
                    className={`${field} w-48`}
                  />
                  <button className="rounded border border-red-300 px-3 py-1.5 text-red-700 hover:bg-red-50">
                    Cancel
                  </button>
                </form>
              </div>
            </div>
          ))}
        </section>
      )}

      <section className="space-y-3">
        <h2 className="font-semibold">Invoices</h2>
        <div className="overflow-x-auto rounded border border-slate-200 bg-white">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-slate-600">
              <tr>
                <th className="px-3 py-2">School</th>
                <th className="px-3 py-2">Session</th>
                <th className="px-3 py-2">Reference</th>
                <th className="px-3 py-2">Amount</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Licence until</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {subs.map((s) => (
                <tr
                  key={s.id as string}
                  className="border-b border-slate-100 align-top last:border-0"
                >
                  <td className="px-3 py-2">{nameOf(s.school_id as string)}</td>
                  <td className="px-3 py-2">{s.session as string}</td>
                  <td className="px-3 py-2 font-mono text-xs">{s.reference as string}</td>
                  <td className="px-3 py-2">{formatNaira(Number(s.amount_kobo))}</td>
                  <td className="px-3 py-2">
                    <span
                      className={`rounded px-2 py-0.5 text-xs font-medium ${STATUS[s.status as string] ?? ""}`}
                    >
                      {label(s.status as string)}
                    </span>
                  </td>
                  <td className="px-3 py-2">{day(s.valid_until as string)}</td>
                  <td className="space-y-1 px-3 py-2">
                    {s.status === "pending" && (
                      <>
                        <details>
                          <summary className="cursor-pointer text-blue-700">Mark paid</summary>
                          <form action={markPaidAction} className="mt-2 space-y-2">
                            <input type="hidden" name="subscriptionId" value={s.id as string} />
                            <input
                              name="paymentRef"
                              placeholder="Bank reference (optional)"
                              className={`${field} w-56`}
                            />
                            <input
                              name="reason"
                              placeholder="Why (for example: cash at the office)"
                              className={`${field} w-56`}
                            />
                            <button className="rounded bg-slate-900 px-3 py-1 text-white">
                              Mark paid
                            </button>
                          </form>
                        </details>
                        <details>
                          <summary className="cursor-pointer text-red-700">Cancel</summary>
                          <form action={cancelInvoiceAction} className="mt-2 space-y-2">
                            <input type="hidden" name="subscriptionId" value={s.id as string} />
                            <input name="reason" placeholder="Why" className={`${field} w-56`} />
                            <button className="rounded border border-red-300 px-3 py-1 text-red-700">
                              Cancel invoice
                            </button>
                          </form>
                        </details>
                      </>
                    )}
                    {s.status === "paid" && (
                      <>
                        <details>
                          <summary className="cursor-pointer text-blue-700">Extend</summary>
                          <form action={extendInvoiceAction} className="mt-2 space-y-2">
                            <input type="hidden" name="subscriptionId" value={s.id as string} />
                            <label className="block">
                              <span className="text-xs text-slate-600">
                                New valid-until (later than {day(s.valid_until as string)})
                              </span>
                              <input name="validUntil" type="date" className={`${field} w-44`} />
                            </label>
                            <input
                              name="graceDays"
                              type="number"
                              min={0}
                              max={180}
                              placeholder="Grace days (14)"
                              className={`${field} w-44`}
                            />
                            <input name="reason" placeholder="Why" className={`${field} w-56`} />
                            <button className="rounded bg-slate-900 px-3 py-1 text-white">
                              Extend
                            </button>
                          </form>
                        </details>
                        <details>
                          <summary className="cursor-pointer text-blue-700">
                            Top up students
                          </summary>
                          <form action={createTopupAction} className="mt-2 space-y-2">
                            <input type="hidden" name="subscriptionId" value={s.id as string} />
                            <input
                              name="extraStudents"
                              type="number"
                              min={1}
                              placeholder="Extra students"
                              className={`${field} w-44`}
                            />
                            <button className="rounded bg-slate-900 px-3 py-1 text-white">
                              Invoice top-up
                            </button>
                          </form>
                        </details>
                        {actor.role === "owner" &&
                          Date.now() - Date.parse(s.paid_at as string) <=
                            REFUND_DAYS * 86_400_000 && (
                            <details>
                              <summary className="cursor-pointer text-red-700">Refund</summary>
                              <form action={refundInvoiceAction} className="mt-2 space-y-2">
                                <input type="hidden" name="subscriptionId" value={s.id as string} />
                                <p className="max-w-xs text-xs text-slate-600">
                                  Ends the licence now and records the refund of{" "}
                                  {formatNaira(Number(s.amount_kobo) + Number(s.topup_kobo))}. Send
                                  the money back from your bank yourself.
                                </p>
                                <input
                                  name="reason"
                                  placeholder="Why"
                                  className={`${field} w-56`}
                                />
                                <input
                                  name="confirm"
                                  placeholder="Type REFUND"
                                  autoComplete="off"
                                  className={`${field} w-56`}
                                />
                                <button className="rounded border border-red-300 px-3 py-1 text-red-700">
                                  Refund invoice
                                </button>
                              </form>
                            </details>
                          )}
                      </>
                    )}
                    {["pending", "pending_confirmation", "paid", "refunded"].includes(
                      s.status as string
                    ) && (
                      <a
                        href={`/billing/${s.id as string}/pdf`}
                        className="block text-blue-700 hover:underline"
                      >
                        {s.status === "paid" || s.status === "refunded"
                          ? "Receipt (PDF)"
                          : "Invoice (PDF)"}
                      </a>
                    )}
                  </td>
                </tr>
              ))}
              {subs.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-3 py-3 text-slate-600">
                    No invoices yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {decided.length > 0 && (
        <section className="space-y-3">
          <h2 className="font-semibold">Recently decided claims</h2>
          <ul className="space-y-1 text-sm">
            {decided.map((c) => (
              <li key={c.id as string} className="flex flex-wrap gap-2">
                <span className={c.status === "confirmed" ? "text-green-700" : "text-red-700"}>
                  {c.status as string}
                </span>
                <span>{nameOf(c.school_id as string)}</span>
                <span>{formatNaira(Number(c.amount_kobo))}</span>
                <span className="text-slate-500">
                  by {c.decided_by as string} {ago(c.decided_at as string)}:{" "}
                  {c.decision_reason as string}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
