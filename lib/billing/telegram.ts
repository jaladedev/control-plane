import { formatNaira } from "@/lib/billing/money";

// What Telegram is told, and how it is sent. Plain text only (no markup, so
// nothing a school typed can break the message), and no personal data beyond what
// the person confirming needs: school, amount, reference, session.

export type ClaimNotice = {
  kind: "claim" | "reminder";
  schoolName: string;
  amountKobo: number;
  reference: string;
  session: string;
  sentOn: string;
  ageHours: number;
  appUrl?: string | null;
};

const clean = (text: string) => text.replace(/[\r\n]+/g, " ").slice(0, 120);

export function claimNotice(n: ClaimNotice): string {
  const head =
    n.kind === "reminder"
      ? `Reminder: a transfer claim has waited ${Math.floor(n.ageHours)} hours`
      : "New transfer claim";
  const lines = [
    head,
    `School: ${clean(n.schoolName)}`,
    `Amount: ${formatNaira(n.amountKobo)}`,
    `Invoice: ${n.reference} (${clean(n.session)})`,
    `Sent on: ${n.sentOn}`,
    "Check your bank statement, then confirm or reject it.",
  ];
  if (n.appUrl) lines.push(`${n.appUrl.replace(/\/+$/, "")}/billing`);
  return lines.join("\n");
}

/** Sends one message. Errors never contain the bot token. */
export async function sendTelegram(p: {
  token: string;
  chatId: string;
  text: string;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const f = p.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await f(`https://api.telegram.org/bot${p.token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: p.chatId, text: p.text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.name : "error";
    throw new Error(`Could not reach Telegram (${reason}).`);
  }
  if (!res.ok) {
    let why = "";
    try {
      why = ((await res.json()) as { description?: string }).description ?? "";
    } catch {
      // not JSON
    }
    throw new Error(`Telegram answered ${res.status}${why ? `: ${why.slice(0, 120)}` : ""}.`);
  }
}
