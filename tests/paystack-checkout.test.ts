import { describe, expect, it, vi } from "vitest";
import { CHECKOUT_LIMITS, handleCheckout, type CheckoutDeps } from "@/lib/paystack/checkout";
import { generateClaimKeyPair, signClaim } from "@/lib/billing/claim-signature";

const keys = generateClaimKeyPair();
const NOW = new Date("2026-10-25T12:00:00Z");
const TS = Math.floor(NOW.getTime() / 1000);
const body = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    subscription_reference: "SUB-0A1B2C3D",
    payer_email: "bursar@school.example",
    return_url: "https://school.example/renewal",
    ...over,
  });

function setup(over: Partial<CheckoutDeps> = {}, status = "active") {
  const deps: CheckoutDeps = {
    findSchool: vi.fn(async (slug: string) =>
      slug === "greenfield" ? { id: "school-1", status } : null
    ),
    publicKeys: vi.fn(async () => [keys.publicKey]),
    rateLimit: vi.fn(async () => true),
    configured: true,
    begin: vi.fn(async () => ({ reference: "PSK-0123456789ABCDEF", amountKobo: 15_000_000 })),
    initialize: vi.fn(async () => ({ authorizationUrl: "https://checkout.paystack.com/abc" })),
    audit: vi.fn(async () => {}),
    ...over,
  };
  const send = (raw: string, purpose: "checkout-v1" | "claim-v1" | "proof-v1" = "checkout-v1") =>
    handleCheckout(
      {
        slug: "greenfield",
        timestamp: String(TS),
        signature: signClaim({
          privateKey: keys.privateKey,
          slug: "greenfield",
          timestamp: TS,
          body: raw,
          purpose,
        }),
        rawBody: raw,
        ip: "203.0.113.7",
      },
      deps,
      NOW
    );
  return { deps, send };
}

describe("handleCheckout", () => {
  it("starts a checkout for the invoice's own amount and returns the Paystack page", async () => {
    const { deps, send } = setup();
    const res = await send(body());
    expect(res).toEqual({
      status: 201,
      body: {
        ok: true,
        authorization_url: "https://checkout.paystack.com/abc",
        reference: "PSK-0123456789ABCDEF",
      },
    });
    expect(deps.begin).toHaveBeenCalledWith("school-1", "SUB-0A1B2C3D", "bursar@school.example");
    expect(deps.initialize).toHaveBeenCalledWith({
      email: "bursar@school.example",
      amountKobo: 15_000_000,
      reference: "PSK-0123456789ABCDEF",
      callbackUrl: "https://school.example/renewal",
      metadata: { school: "greenfield", invoice: "SUB-0A1B2C3D" },
    });
    expect(deps.audit).toHaveBeenCalledWith("paystack.checkout", "school-1", {
      invoice: "SUB-0A1B2C3D",
      reference: "PSK-0123456789ABCDEF",
      amount_kobo: 15_000_000,
    });
  });

  it("takes no amount from the caller: a body that names one is refused", async () => {
    const { deps, send } = setup();
    const res = await send(body({ amount_kobo: 1 }));
    expect(res.status).toBe(400);
    expect(deps.begin).not.toHaveBeenCalled();
  });

  it("refuses requests signed for another purpose", async () => {
    for (const purpose of ["claim-v1", "proof-v1"] as const) {
      const { deps, send } = setup();
      expect((await send(body(), purpose)).status).toBe(401);
      expect(deps.begin).not.toHaveBeenCalled();
    }
  });

  it("limits checkouts per address and per school in their own buckets", async () => {
    const { deps, send } = setup();
    await send(body());
    expect(deps.rateLimit).toHaveBeenCalledWith(
      "checkout:ip:203.0.113.7",
      CHECKOUT_LIMITS.perAddress.windowSeconds,
      CHECKOUT_LIMITS.perAddress.max
    );
    expect(deps.rateLimit).toHaveBeenCalledWith(
      "checkout:school:school-1",
      CHECKOUT_LIMITS.perSchool.windowSeconds,
      CHECKOUT_LIMITS.perSchool.max
    );
    const limited = setup({
      rateLimit: vi.fn(async (b: string) => !b.startsWith("checkout:school:")),
    });
    expect((await limited.send(body())).status).toBe(429);
    expect(limited.deps.begin).not.toHaveBeenCalled();
  });

  it("refuses a bad reference, a bad email and a return address that is not https", async () => {
    const { deps, send } = setup();
    for (const bad of [
      { subscription_reference: "sub-0a1b2c3d" },
      { subscription_reference: "SUB-XYZ" },
      { payer_email: "nobody" },
      { return_url: "http://school.example/renewal" },
      { return_url: "javascript:alert(1)" },
      { return_url: "not a url" },
    ]) {
      expect((await send(body(bad))).status, JSON.stringify(bad)).toBe(400);
    }
    expect(deps.begin).not.toHaveBeenCalled();
  });

  it("works without a return address", async () => {
    const { deps, send } = setup();
    await send(body({ return_url: undefined }));
    expect(deps.initialize).toHaveBeenCalledWith(
      expect.objectContaining({ callbackUrl: undefined })
    );
  });

  it("passes the database's wording through when the invoice cannot be paid", async () => {
    const { deps, send } = setup({
      begin: vi.fn(async () => ({ businessError: "That invoice has already been paid." })),
    });
    expect(await send(body())).toEqual({
      status: 409,
      body: { ok: false, error: "That invoice has already been paid." },
    });
    expect(deps.initialize).not.toHaveBeenCalled();
    expect(deps.audit).not.toHaveBeenCalled();
  });

  it("says card payments are unavailable when no secret key is set, creating nothing", async () => {
    const { deps, send } = setup({ configured: false });
    const res = await send(body());
    expect(res.status).toBe(503);
    expect(deps.begin).not.toHaveBeenCalled();
  });

  it("answers 502 in plain words when Paystack does not respond, without leaking why", async () => {
    const { send } = setup({
      initialize: vi.fn(async () => {
        throw new Error("Paystack answered 500 secret detail");
      }),
    });
    const res = await send(body());
    expect(res.status).toBe(502);
    expect(JSON.stringify(res.body)).not.toContain("secret detail");
  });

  it("refuses an archived school", async () => {
    expect((await setup({}, "archived").send(body())).status).toBe(403);
  });
});
