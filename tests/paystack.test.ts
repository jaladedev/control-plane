import { describe, expect, it, vi } from "vitest";
import { paystackSignature, verifyPaystackSignature } from "@/lib/paystack/signature";
import { handlePaystackWebhook, type WebhookDeps } from "@/lib/paystack/webhook";
import { initializeTransaction } from "@/lib/paystack/client";

const SECRET = "sk_test_0123456789abcdef";

describe("paystack signature", () => {
  // Computed independently with Python's hmac and hashlib.
  const BODY = '{"event":"charge.success","data":{"id":302961}}';
  const SIG =
    "5efb82b528d5d4abf4c9d8ab11e720d9e7dc4e061b6ed8b81675c6e21981ddc6e9a1214580ee8f8d9895fa3994e5a4d4b165d6f62a15ff49d3b15362b44609a4";

  it("is HMAC-SHA512 of the exact body with the secret key, in hex", () => {
    expect(paystackSignature(BODY, SECRET)).toBe(SIG);
    expect(verifyPaystackSignature(BODY, SIG, SECRET)).toBe(true);
  });
  it("accepts upper-case hex but nothing that is not the right signature", () => {
    expect(verifyPaystackSignature(BODY, SIG.toUpperCase(), SECRET)).toBe(true);
    expect(verifyPaystackSignature(BODY + " ", SIG, SECRET)).toBe(false);
    expect(verifyPaystackSignature(BODY, SIG, "sk_test_other0123456789")).toBe(false);
    expect(verifyPaystackSignature(BODY, SIG.slice(0, -2) + "00", SECRET)).toBe(false);
    for (const bad of [null, undefined, "", "abc", "z".repeat(128), SIG + "00"]) {
      expect(verifyPaystackSignature(BODY, bad, SECRET)).toBe(false);
    }
  });
});

const charge = (over: Record<string, unknown> = {}, event = "charge.success") =>
  JSON.stringify({
    event,
    data: {
      id: 302961,
      reference: "PSK-0123456789ABCDEF",
      amount: 15_000_000,
      currency: "NGN",
      status: "success",
      ...over,
    },
  });

function hook(over: Partial<WebhookDeps> = {}) {
  const deps: WebhookDeps = {
    secret: SECRET,
    recordCharge: vi.fn(async () => "applied" as const),
    audit: vi.fn(async () => {}),
    ...over,
  };
  const send = (raw: string, signature: string | null = paystackSignature(raw, SECRET)) =>
    handlePaystackWebhook({ rawBody: raw, signature }, deps);
  return { deps, send };
}

describe("handlePaystackWebhook", () => {
  it("records a signed successful charge and audits it", async () => {
    const { deps, send } = hook();
    expect(await send(charge())).toEqual({ status: 200, body: { ok: true, result: "applied" } });
    expect(deps.recordCharge).toHaveBeenCalledWith({
      reference: "PSK-0123456789ABCDEF",
      paystackId: "302961",
      amountKobo: 15_000_000,
      currency: "NGN",
    });
    expect(deps.audit).toHaveBeenCalledWith("paystack.charge_applied", {
      reference: "PSK-0123456789ABCDEF",
      paystack_id: "302961",
      amount_kobo: 15_000_000,
      currency: "NGN",
    });
  });

  it("answers 401 to a bad or missing signature and records nothing", async () => {
    const { deps, send } = hook();
    expect((await send(charge(), null)).status).toBe(401);
    expect((await send(charge(), "0".repeat(128))).status).toBe(401);
    expect(
      (await send(charge(), paystackSignature(charge(), "sk_test_other0123456789"))).status
    ).toBe(401);
    expect(deps.recordCharge).not.toHaveBeenCalled();
  });

  it("is not set up without a secret key", async () => {
    const { deps, send } = hook({ secret: null });
    expect((await send(charge())).status).toBe(503);
    expect(deps.recordCharge).not.toHaveBeenCalled();
  });

  it("checks the signature before it reads the body", async () => {
    const { send } = hook();
    expect((await send("not json", null)).status).toBe(401);
    expect((await send("not json")).status).toBe(400);
    const big = "x".repeat(70 * 1024);
    expect((await send(big, null)).status).toBe(413);
  });

  it("acknowledges events that are not a successful charge of ours, recording nothing", async () => {
    const { deps, send } = hook();
    for (const raw of [
      charge({}, "charge.failed"),
      charge({}, "refund.processed"),
      charge({ status: "failed" }),
      charge({ reference: "someone-elses-ref" }),
      charge({ amount: 0 }),
      charge({ amount: 12.5 }),
      charge({ currency: undefined }),
      JSON.stringify({ event: "charge.success" }),
      JSON.stringify([1, 2]),
    ]) {
      expect(await send(raw), raw).toEqual({ status: 200, body: { ok: true, ignored: true } });
    }
    expect(deps.recordCharge).not.toHaveBeenCalled();
  });

  it("passes the database's verdict through, and stays quiet on duplicates and strangers", async () => {
    for (const result of ["needs_review", "applied"] as const) {
      const { deps, send } = hook({ recordCharge: vi.fn(async () => result) });
      expect((await send(charge())).body).toEqual({ ok: true, result });
      expect(deps.audit).toHaveBeenCalledWith(`paystack.charge_${result}`, expect.any(Object));
    }
    for (const result of ["duplicate", "unknown"] as const) {
      const { deps, send } = hook({ recordCharge: vi.fn(async () => result) });
      expect((await send(charge())).status).toBe(200);
      expect(deps.audit).not.toHaveBeenCalled();
    }
  });

  it("answers 500, so Paystack sends it again, when the charge could not be written down", async () => {
    const { send } = hook({
      recordCharge: vi.fn(async () => {
        throw new Error("database down");
      }),
    });
    expect(await send(charge())).toEqual({ status: 500, body: { ok: false } });
  });

  it("does not ask Paystack to resend a charge that is recorded just because the audit failed", async () => {
    const { send } = hook({
      audit: vi.fn(async () => {
        throw new Error("audit down");
      }),
    });
    expect((await send(charge())).status).toBe(200);
  });

  it("accepts a string transaction id", async () => {
    const { deps, send } = hook();
    await send(charge({ id: "4099260516" }));
    expect(deps.recordCharge).toHaveBeenCalledWith(
      expect.objectContaining({ paystackId: "4099260516" })
    );
  });
});

describe("initializeTransaction", () => {
  const params = {
    email: "bursar@school.example",
    amountKobo: 15_000_000,
    reference: "PSK-0123456789ABCDEF",
    callbackUrl: "https://school.example/renewal",
    metadata: { school: "greenfield", invoice: "SUB-0A1B2C3D" },
  };
  const ok = (over: Record<string, unknown> = {}) =>
    vi.fn(async () =>
      Response.json({
        status: true,
        data: {
          authorization_url: "https://checkout.paystack.com/abc123",
          access_code: "abc123",
          reference: params.reference,
          ...over,
        },
      })
    );

  it("posts the amount in kobo with the secret key and returns the payment page", async () => {
    const fetchImpl = ok();
    expect(await initializeTransaction(SECRET, params, fetchImpl as never)).toEqual({
      authorizationUrl: "https://checkout.paystack.com/abc123",
    });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.paystack.co/transaction/initialize");
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${SECRET}`);
    expect(JSON.parse(init.body as string)).toEqual({
      email: "bursar@school.example",
      amount: 15_000_000,
      currency: "NGN",
      reference: "PSK-0123456789ABCDEF",
      callback_url: "https://school.example/renewal",
      metadata: { school: "greenfield", invoice: "SUB-0A1B2C3D" },
    });
  });

  it("leaves out the callback when there is none", async () => {
    const fetchImpl = ok();
    await initializeTransaction(SECRET, { ...params, callbackUrl: undefined }, fetchImpl as never);
    expect(
      JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)
    ).not.toHaveProperty("callback_url");
  });

  it("refuses a reply that is an error, has no page, names another reference, or sends the payer elsewhere", async () => {
    const bad: [string, typeof fetch][] = [
      ["http error", vi.fn(async () => Response.json({ status: false }, { status: 401 })) as never],
      ["status false", vi.fn(async () => Response.json({ status: false, data: {} })) as never],
      ["no body", vi.fn(async () => new Response("oops", { status: 200 })) as never],
      ["other reference", ok({ reference: "PSK-FFFFFFFFFFFFFFFF" }) as never],
      ["other host", ok({ authorization_url: "https://evil.example/pay" }) as never],
      ["http page", ok({ authorization_url: "http://checkout.paystack.com/abc" }) as never],
      [
        "look-alike host",
        ok({ authorization_url: "https://checkout.paystack.com.evil.example/x" }) as never,
      ],
    ];
    for (const [name, fetchImpl] of bad) {
      await expect(initializeTransaction(SECRET, params, fetchImpl), name).rejects.toThrow();
    }
  });
});
