// Sends one plain-text email through Resend (https://resend.com). Plain text only,
// so nothing a school typed can become markup. Errors never contain the API key.

export type EmailConfig = {
  apiKey: string;
  /** "Name <address@domain>" or a bare address, on a domain verified with Resend. */
  from: string;
  replyTo?: string | null;
};

export type EmailMessage = {
  to: string;
  subject: string;
  text: string;
  /** Stops a retry from sending twice, where the provider supports it. */
  idempotencyKey?: string;
};

const ADDRESS = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
const oneLine = (s: string, n: number) =>
  s
    .replace(/[\r\n]+/g, " ")
    .trim()
    .slice(0, n);

export function isEmailAddress(value: string | null | undefined): value is string {
  return typeof value === "string" && value.length <= 254 && ADDRESS.test(value.trim());
}

export async function sendEmail(
  cfg: EmailConfig,
  msg: EmailMessage,
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  if (!isEmailAddress(msg.to)) throw new Error("The recipient is not a valid email address.");
  const headers: Record<string, string> = {
    authorization: `Bearer ${cfg.apiKey}`,
    "content-type": "application/json",
  };
  if (msg.idempotencyKey) headers["idempotency-key"] = msg.idempotencyKey.slice(0, 256);

  let res: Response;
  try {
    res = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers,
      body: JSON.stringify({
        from: cfg.from,
        to: [msg.to.trim()],
        subject: oneLine(msg.subject, 200),
        text: msg.text,
        ...(cfg.replyTo ? { reply_to: cfg.replyTo } : {}),
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new Error(
      `Could not reach the email provider (${error instanceof Error ? error.name : "error"}).`
    );
  }
  if (!res.ok) {
    let why = "";
    try {
      const body = (await res.json()) as { message?: string; name?: string };
      why = body.message ?? body.name ?? "";
    } catch {
      // not JSON: the status alone will do
    }
    const scrubbed = why.split(cfg.apiKey).join("[secret]");
    throw new Error(
      `The email provider refused the message (HTTP ${res.status})${scrubbed ? `: ${oneLine(scrubbed, 200)}` : "."}`
    );
  }
}
