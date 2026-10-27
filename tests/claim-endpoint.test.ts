import { describe, expect, it, vi } from "vitest";
import { MAX_BODY_BYTES, handleClaim, type ClaimDeps } from "@/lib/billing/claim-endpoint";
import { generateClaimKeyPair, signClaim } from "@/lib/billing/claim-signature";

const keys = generateClaimKeyPair();
const NOW = new Date("2026-10-25T12:00:00Z");
const TS = Math.floor(NOW.getTime() / 1000);
const body = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    subscription_reference: "SUB-0A1B2C3D",
    client_ref: "claim-0001",
    amount_kobo: 15_000_000,
    sent_on: "2026-10-24",
    sender_name: "A. Bursar",
    claimed_by: "bursar@school.example",
    ...over,
  });

function setup(over: Partial<ClaimDeps> = {}, status = "active") {
  const deps: ClaimDeps = {
    findSchool: vi.fn(async (slug: string) =>
      slug === "greenfield" ? { id: "school-1", status } : null
    ),
    publicKeys: vi.fn(async () => [keys.publicKey]),
    audit: vi.fn(async () => {}),
    submit: vi.fn(async () => ({ claimId: "claim-id-1" })),
    ...over,
  };
  const send = (
    rawBody: string,
    o: {
      slug?: string | null;
      timestamp?: number | string | null;
      signature?: string | null;
      key?: string;
    } = {}
  ) => {
    const timestamp = o.timestamp === undefined ? TS : o.timestamp;
    const slug = o.slug === undefined ? "greenfield" : o.slug;
    const signature =
      o.signature === undefined
        ? signClaim({
            privateKey: o.key ?? keys.privateKey,
            slug: "greenfield",
            timestamp: TS,
            body: rawBody,
          })
        : o.signature;
    return handleClaim(
      { slug, timestamp: timestamp === null ? null : String(timestamp), signature, rawBody },
      deps,
      NOW
    );
  };
  return { deps, send };
}
const REJECTED = { status: 401, body: { ok: false, error: "Request rejected." } };

describe("a valid signed claim", () => {
  it("is audited first, then recorded, and answered 201 with the claim id", async () => {
    const order: string[] = [];
    const { deps, send } = setup({
      audit: vi.fn(async () => void order.push("audit")),
      submit: vi.fn(async () => (order.push("submit"), { claimId: "claim-id-1" })),
    });
    expect(await send(body())).toEqual({ status: 201, body: { ok: true, claim_id: "claim-id-1" } });
    expect(order).toEqual(["audit", "submit"]);
    expect(deps.audit).toHaveBeenCalledWith("claim.submit", "school-1", {
      reference: "SUB-0A1B2C3D",
      client_ref: "claim-0001",
      amount_kobo: 15_000_000,
    });
    expect(deps.submit).toHaveBeenCalledWith(
      "school-1",
      expect.objectContaining({ amount_kobo: 15_000_000, claimed_by: "bursar@school.example" })
    );
  });
  it("still works for a suspended school, which is exactly who needs to pay", async () => {
    const { send } = setup({}, "suspended");
    expect((await send(body())).status).toBe(201);
  });
});

describe("authentication failures all look the same", () => {
  it.each([
    ["no slug", (s: ReturnType<typeof setup>) => s.send(body(), { slug: null })],
    ["a malformed slug", (s: ReturnType<typeof setup>) => s.send(body(), { slug: "Green Field!" })],
    ["no signature", (s: ReturnType<typeof setup>) => s.send(body(), { signature: null })],
    ["a garbage signature", (s: ReturnType<typeof setup>) => s.send(body(), { signature: "AAAA" })],
    ["no timestamp", (s: ReturnType<typeof setup>) => s.send(body(), { timestamp: null })],
    [
      "a non-numeric timestamp",
      (s: ReturnType<typeof setup>) => s.send(body(), { timestamp: "yesterday" }),
    ],
    [
      "a stale timestamp",
      (s: ReturnType<typeof setup>) => s.send(body(), { timestamp: TS - 3600 }),
    ],
    [
      "another school's key",
      (s: ReturnType<typeof setup>) => s.send(body(), { key: generateClaimKeyPair().privateKey }),
    ],
    ["an unknown school", (s: ReturnType<typeof setup>) => s.send(body(), { slug: "nowhere" })],
  ])("%s", async (_why, run) => {
    const s = setup();
    expect(await run(s)).toEqual(REJECTED);
    expect(s.deps.audit).not.toHaveBeenCalled();
    expect(s.deps.submit).not.toHaveBeenCalled();
  });

  it("answers a school with no registered key exactly as a wrong key", async () => {
    const s = setup({ publicKeys: vi.fn(async () => []) });
    expect(await s.send(body())).toEqual(REJECTED);
  });
  it("answers a revoked key (no longer listed) as rejected", async () => {
    const s = setup({ publicKeys: vi.fn(async () => [generateClaimKeyPair().publicKey]) });
    expect(await s.send(body())).toEqual(REJECTED);
  });
  it("rejects a body altered after signing", async () => {
    const s = setup();
    const signature = signClaim({
      privateKey: keys.privateKey,
      slug: "greenfield",
      timestamp: TS,
      body: body(),
    });
    expect(await s.send(body({ amount_kobo: 1 }), { signature })).toEqual(REJECTED);
    expect(s.deps.submit).not.toHaveBeenCalled();
  });
  it("turns away an obviously bad request before any database work", async () => {
    for (const o of [
      { signature: null },
      { timestamp: TS - 3600 },
      { timestamp: null },
      { slug: "Bad Slug" },
    ]) {
      const s = setup();
      expect(await s.send(body(), o)).toEqual(REJECTED);
      expect(s.deps.findSchool).not.toHaveBeenCalled();
    }
  });
  it("must look the school up to get its keys, but the answer never depends on what it found", async () => {
    const known = setup();
    const unknown = setup();
    const a = await known.send(body(), { signature: "AAAA" });
    const b = await unknown.send(body(), { slug: "nowhere", signature: "AAAA" });
    expect(a).toEqual(b);
    expect(known.deps.findSchool).toHaveBeenCalled();
  });
});

describe("after authentication", () => {
  it("refuses an archived school", async () => {
    expect((await setup({}, "archived").send(body())).status).toBe(403);
  });
  it.each([
    ["not JSON", "{nope", /valid JSON/],
    ["an unknown field", body({ extra: 1 }), /Unrecognized key/],
    ["a bad reference", body({ subscription_reference: "INV-1" }), /invoice reference/],
    ["a short client_ref", body({ client_ref: "x" }), /client_ref/],
    ["a negative amount", body({ amount_kobo: -5 }), /amount_kobo/],
    ["a fractional amount", body({ amount_kobo: 10.5 }), /amount_kobo/],
    ["amount as text", body({ amount_kobo: "15000000" }), /amount_kobo/],
    ["a bad date", body({ sent_on: "yesterday" }), /sent_on/],
    ["a missing sender", body({ sender_name: "" }), /sender_name/],
  ])("answers 400 for %s, and records nothing", async (_why, raw, message) => {
    const s = setup();
    const r = await s.send(raw);
    expect(r.status).toBe(400);
    expect(String(r.body.error)).toMatch(message);
    expect(s.deps.audit).not.toHaveBeenCalled();
    expect(s.deps.submit).not.toHaveBeenCalled();
  });
  it("answers 409 with the rule that was broken, so the school can tell its user", async () => {
    const s = setup({
      submit: vi.fn(async () => ({ businessError: "That invoice has already been paid." })),
    });
    expect(await s.send(body())).toEqual({
      status: 409,
      body: { ok: false, error: "That invoice has already been paid." },
    });
  });
  it("refuses an oversized body before doing anything", async () => {
    const s = setup();
    const r = await s.send(body({ sender_name: "x".repeat(MAX_BODY_BYTES) }));
    expect(r.status).toBe(413);
    expect(s.deps.findSchool).not.toHaveBeenCalled();
  });
  it("does not record the claim if the audit row cannot be written", async () => {
    const s = setup({
      audit: vi.fn(async () => {
        throw new Error("audit down");
      }),
    });
    await expect(s.send(body())).rejects.toThrow(/audit down/);
    expect(s.deps.submit).not.toHaveBeenCalled();
  });
});
