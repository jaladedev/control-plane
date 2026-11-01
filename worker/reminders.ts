import { isEmailAddress, type EmailConfig, sendEmail } from "@/lib/billing/email";
import {
  isReminderKind,
  reminderEmail,
  reminderOwnerNotice,
  type ReminderKind,
} from "@/lib/billing/reminder";
import type { HandlerDeps, HandlerResult } from "@/worker/handlers";
import type { Job } from "@/worker/store";

// Sends one invoice reminder: an email to the school's billing contact, then a line
// to you on Telegram. The database decides who is due (enqueue_invoice_reminders) and
// records what went out (mark_invoice_reminded). Here the job re-checks that the
// reminder is still wanted, because a payment, a cancellation or a newer stage can
// land between queueing and running.
//
// Order matters: the email goes first, and the stage is recorded only after it was
// accepted, so a failed send is tried again. The rare opposite failure (sent, but the
// record could not be written) can send one stage twice; the idempotency key makes the
// provider drop the repeat where it supports that.

export type ReminderDeps = {
  email?: EmailConfig & { send?: typeof sendEmail };
  /** Shown as a contact line in the email. */
  supportEmail?: string | null;
  now?: () => Date;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function handleInvoiceReminder(
  job: Job,
  deps: HandlerDeps & ReminderDeps
): Promise<HandlerResult> {
  const { store } = deps;
  const sub = String(job.payload.subscription_id ?? "");
  const kind = job.payload.kind;
  if (!UUID.test(sub) || !isReminderKind(kind)) {
    return { ok: false, error: "The reminder job has no invoice or stage." };
  }

  const inv = await store.invoiceForReminder(sub);
  if (!inv) return { ok: false, error: "That invoice does not exist." };

  // Nothing to say any more? Say nothing, and succeed: this is not an error.
  if (inv.status !== "pending")
    return { ok: true, result: { skipped: `invoice is ${inv.status}` } };
  if (inv.school_status !== "active") {
    return { ok: true, result: { skipped: `school is ${inv.school_status}` } };
  }
  if (inv.sent_kinds.includes(kind)) return { ok: true, result: { skipped: "already sent" } };
  if (inv.current_kind !== kind) {
    // The school has moved on to another stage; the next scan queues that one.
    return { ok: true, result: { skipped: `stage is now ${inv.current_kind ?? "none"}` } };
  }
  if (!inv.license_valid_until || !inv.license_grace_until) {
    return { ok: true, result: { skipped: "the school has no licence dates" } };
  }

  const to = isEmailAddress(inv.billing_contact_email) ? inv.billing_contact_email.trim() : null;
  if (to) {
    if (!deps.email) {
      return {
        ok: false,
        error:
          "Email is not set up on the worker (RESEND_API_KEY and EMAIL_FROM_ADDRESS), so the reminder was not sent. " +
          "Set them and it is tried again within a day.",
      };
    }
    const { subject, text } = reminderEmail({
      kind,
      schoolName: inv.school_name,
      contactName: inv.billing_contact_name,
      reference: inv.reference,
      session: inv.session,
      amountKobo: inv.amount_kobo,
      licenceEnds: new Date(inv.license_valid_until),
      graceEnds: new Date(inv.license_grace_until),
      hostname: inv.hostname,
      supportEmail: deps.supportEmail ?? null,
      now: (deps.now ?? (() => new Date()))(),
    });
    // A failure throws, so the worker retries the job; nothing is recorded.
    await (deps.email.send ?? sendEmail)(
      { apiKey: deps.email.apiKey, from: deps.email.from, replyTo: deps.email.replyTo },
      { to, subject, text, idempotencyKey: `invoice-reminder-${sub}-${kind}` }
    );
  }

  await store.markInvoiceReminded(sub, kind as ReminderKind, to);
  await notifyOwner(
    deps,
    reminderOwnerNotice({ kind, schoolName: inv.school_name, reference: inv.reference, sentTo: to })
  );
  return { ok: true, result: { kind, sent_to: to } };
}

// Telling you is secondary: a failed notice never undoes a reminder that went out.
async function notifyOwner(deps: HandlerDeps, text: string) {
  try {
    await deps.telegram?.send(text);
  } catch (error) {
    deps.log(`notice failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
