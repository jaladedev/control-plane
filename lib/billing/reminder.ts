import { formatNaira } from "@/lib/billing/money";

// The words of an invoice reminder. Pure, so the wording and the dates are tested
// without sending anything. Plain text; every value that came from the database is
// flattened to one line first.

export const REMINDER_KINDS = ["before_14", "before_3", "grace", "lapsed"] as const;
export type ReminderKind = (typeof REMINDER_KINDS)[number];

export const isReminderKind = (v: unknown): v is ReminderKind =>
  typeof v === "string" && (REMINDER_KINDS as readonly string[]).includes(v);

export type ReminderInput = {
  kind: ReminderKind;
  schoolName: string;
  contactName: string | null;
  reference: string;
  session: string;
  amountKobo: number;
  licenceEnds: Date;
  graceEnds: Date;
  /** The school's own address, where its bursar pays. Without one the pointer is generic. */
  hostname: string | null;
  supportEmail?: string | null;
  now: Date;
};

const clean = (s: string, n = 120) =>
  s
    .replace(/[\r\n]+/g, " ")
    .trim()
    .slice(0, n);
const DAY = 86_400_000;
const day = (d: Date) => d.toISOString().slice(0, 10);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function whenLine(i: ReminderInput): string {
  const left = Math.max(0, Math.ceil((i.licenceEnds.getTime() - i.now.getTime()) / DAY));
  switch (i.kind) {
    case "before_14":
    case "before_3":
      return left <= 1
        ? `${clean(i.schoolName)}'s licence ends on ${day(i.licenceEnds)} (today or tomorrow).`
        : `${clean(i.schoolName)}'s licence ends on ${day(i.licenceEnds)}, in ${plural(left, "day")}.`;
    case "grace":
      return `${clean(i.schoolName)}'s licence ended on ${day(i.licenceEnds)}. The school is in its grace period until ${day(i.graceEnds)}; after that it becomes read-only.`;
    case "lapsed":
      return `${clean(i.schoolName)}'s licence and its grace period ended (on ${day(i.graceEnds)}). The school is now read-only.`;
  }
}

export function reminderEmail(i: ReminderInput): { subject: string; text: string } {
  const subject =
    i.kind === "lapsed"
      ? `${clean(i.schoolName, 60)}: licence has lapsed, invoice ${i.reference} is unpaid`
      : i.kind === "grace"
        ? `${clean(i.schoolName, 60)}: licence has ended, invoice ${i.reference} is unpaid`
        : `${clean(i.schoolName, 60)}: licence renewal, invoice ${i.reference} is open`;

  const where = i.hostname
    ? `Sign in to your school's site (https://${clean(i.hostname, 253)}/) as the bursar and open Bursary > School licence.`
    : "Sign in to your school's site as the bursar and open Bursary > School licence.";

  const lines = [
    i.contactName ? `Dear ${clean(i.contactName, 80)},` : "Hello,",
    "",
    whenLine(i),
    "",
    "Open invoice:",
    `  Reference: ${i.reference}`,
    `  Session:   ${clean(i.session, 40)}`,
    `  Amount:    ${formatNaira(i.amountKobo)}`,
    "",
    `${where} You can pay by card, or by bank transfer and then tell us you have sent it, quoting the reference above.`,
    "",
    "If you have already paid, thank you; no action is needed once the payment has been confirmed.",
  ];
  if (i.supportEmail)
    lines.push("", `Questions? Reply to this email or write to ${clean(i.supportEmail, 200)}.`);
  return { subject, text: lines.join("\n") + "\n" };
}

/** The line you are sent on Telegram. */
export function reminderOwnerNotice(p: {
  kind: ReminderKind;
  schoolName: string;
  reference: string;
  sentTo: string | null;
}): string {
  const stage = {
    before_14: "licence ends within 14 days",
    before_3: "licence ends within 3 days",
    grace: "licence ended, in grace",
    lapsed: "licence and grace ended",
  }[p.kind];
  return p.sentTo
    ? `Invoice reminder sent to ${clean(p.sentTo, 200)}: ${clean(p.schoolName)}, ${p.reference} (${stage}).`
    : `No billing contact email for ${clean(p.schoolName)}, so no reminder was sent for ${p.reference} (${stage}). ` +
        "Add one under Details, or contact the school yourself.";
}
