// The one call we make to Paystack: start a transaction and get the page the payer
// is sent to. Everything else arrives as a webhook.

export type InitializeParams = {
  email: string;
  amountKobo: number;
  reference: string;
  callbackUrl?: string;
  metadata: Record<string, string>;
};

export async function initializeTransaction(
  secret: string,
  p: InitializeParams,
  fetchImpl: typeof fetch = fetch
): Promise<{ authorizationUrl: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetchImpl("https://api.paystack.co/transaction/initialize", {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify({
        email: p.email,
        amount: p.amountKobo,
        currency: "NGN",
        reference: p.reference,
        ...(p.callbackUrl ? { callback_url: p.callbackUrl } : {}),
        metadata: p.metadata,
      }),
      signal: controller.signal,
    });
    const json = (await res.json().catch(() => null)) as {
      status?: boolean;
      data?: { authorization_url?: string; reference?: string };
    } | null;
    const url = json?.data?.authorization_url;
    if (!res.ok || json?.status !== true || !url || json.data?.reference !== p.reference) {
      throw new Error(`Paystack answered ${res.status} without a payment page.`);
    }
    // Only ever send a payer to Paystack's own checkout.
    if (new URL(url).protocol !== "https:" || !new URL(url).hostname.endsWith("paystack.com")) {
      throw new Error("Paystack returned an unexpected payment address.");
    }
    return { authorizationUrl: url };
  } finally {
    clearTimeout(timer);
  }
}
