import { describe, expect, it } from "vitest";
import {
  CLAIM_MAX_SKEW_SECONDS,
  claimMessage,
  generateClaimKeyPair,
  isKeyEncoding,
  signClaim,
  timestampFresh,
  verifyClaim,
} from "@/lib/billing/claim-signature";

// The same literal signature is asserted in school_app's tests/controlPlaneClaim.test.ts.
// If either side changes the format, its copy of this test fails.
const SEED = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc";
const PUB = "6kpsY-KcUgq-9VB7Ey7F-ZVHdq6-vnuSQh7qaRRG0iw";
const SIG =
  "IKdfMsNp4xUYdei9bLWGxBh2Ij1TwKxpylkfVRbKW_FjJPlSj1k8MHxIuLCoYJrOCeeUWjTGDbOpqVulNH8XBQ";
const BODY = '{"amount_kobo":15000000,"client_ref":"claim-0001"}';
const TS = 1792749600;

describe("the shared contract", () => {
  it("signs the agreed message to the agreed signature, byte for byte", () => {
    expect(claimMessage({ slug: "greenfield", timestamp: TS, body: BODY })).toBe(
      "claim-v1\ngreenfield\n1792749600\n930cc92a2702c75f1096431e6996ed9fb8fe528d743a1143f434a19c299f2df8"
    );
    expect(signClaim({ privateKey: SEED, slug: "greenfield", timestamp: TS, body: BODY })).toBe(
      SIG
    );
  });
  it("verifies it with the matching public key", () => {
    expect(
      verifyClaim({
        publicKeys: [PUB],
        slug: "greenfield",
        timestamp: TS,
        body: BODY,
        signature: SIG,
      })
    ).toBe(true);
  });
});

describe("verifyClaim", () => {
  const good = { publicKeys: [PUB], slug: "greenfield", timestamp: TS, body: BODY, signature: SIG };
  it("rejects a change to anything it covers", () => {
    expect(verifyClaim({ ...good, slug: "other" })).toBe(false);
    expect(verifyClaim({ ...good, timestamp: TS + 1 })).toBe(false);
    expect(verifyClaim({ ...good, body: BODY.replace("15000000", "1") })).toBe(false);
    expect(verifyClaim({ ...good, body: BODY + " " })).toBe(false);
  });
  it("rejects another school's key, and accepts when any listed key matches (rotation)", () => {
    const other = generateClaimKeyPair();
    expect(verifyClaim({ ...good, publicKeys: [other.publicKey] })).toBe(false);
    expect(verifyClaim({ ...good, publicKeys: [other.publicKey, PUB] })).toBe(true);
    expect(verifyClaim({ ...good, publicKeys: [] })).toBe(false);
  });
  it("never throws on garbage", () => {
    for (const signature of ["", "not base64!!", "AAAA", SIG.slice(0, -3), SIG + "AAAA"]) {
      expect(verifyClaim({ ...good, signature })).toBe(false);
    }
    expect(verifyClaim({ ...good, publicKeys: ["short", "!".repeat(43), PUB] })).toBe(true);
    expect(verifyClaim({ ...good, publicKeys: ["short"] })).toBe(false);
  });
});

describe("keys and freshness", () => {
  it("generates a working pair in the agreed encoding", () => {
    const { privateKey, publicKey } = generateClaimKeyPair();
    expect(isKeyEncoding(privateKey) && isKeyEncoding(publicKey)).toBe(true);
    const signature = signClaim({ privateKey, slug: "a", timestamp: 1, body: "x" });
    expect(
      verifyClaim({ publicKeys: [publicKey], slug: "a", timestamp: 1, body: "x", signature })
    ).toBe(true);
  });
  it("refuses to sign with a malformed key", () => {
    expect(() => signClaim({ privateKey: "nope", slug: "a", timestamp: 1, body: "x" })).toThrow(
      /not valid/
    );
  });
  it("accepts a timestamp within the window and refuses outside it, either side", () => {
    const now = new Date(TS * 1000);
    expect(timestampFresh(TS, now)).toBe(true);
    expect(timestampFresh(TS - CLAIM_MAX_SKEW_SECONDS, now)).toBe(true);
    expect(timestampFresh(TS + CLAIM_MAX_SKEW_SECONDS, now)).toBe(true);
    expect(timestampFresh(TS - CLAIM_MAX_SKEW_SECONDS - 1, now)).toBe(false);
    expect(timestampFresh(TS + CLAIM_MAX_SKEW_SECONDS + 1, now)).toBe(false);
    expect(timestampFresh(Number.NaN, now)).toBe(false);
    expect(timestampFresh(TS + 0.5, now)).toBe(false);
  });
});

describe("purposes", () => {
  const PROOF_SIG =
    "kSZ0ensSYC0nDd0T8v8qC8MvQZbt9LffYm3mI_Nj2qmiJn0PJud-qN0XxNuwX0Ydm9HyYNnSDv2MYxwmHkxDCg";
  const CHECKOUT_SIG =
    "chp09AkA3NLKR7OeTjM-Vyv4ZeB6s-11s7ktr_w8yoGP8_4qHyXpliZ5L0_tTlNLi7jlILuBOm8op7Eh5jpHDQ";
  const base = { slug: "greenfield", timestamp: TS, body: BODY };

  it("signs each purpose to its own agreed literal signature (also asserted in school_app)", () => {
    expect(signClaim({ privateKey: SEED, ...base, purpose: "proof-v1" })).toBe(PROOF_SIG);
    expect(signClaim({ privateKey: SEED, ...base, purpose: "checkout-v1" })).toBe(CHECKOUT_SIG);
    expect(claimMessage({ ...base, purpose: "proof-v1" }).split("\n")[0]).toBe("proof-v1");
  });
  it("treats a missing purpose as a claim, so existing signatures keep working", () => {
    expect(signClaim({ privateKey: SEED, ...base })).toBe(SIG);
    expect(signClaim({ privateKey: SEED, ...base, purpose: "claim-v1" })).toBe(SIG);
  });
  it("accepts a signature only for the purpose it was made for", () => {
    const v = (signature: string, purpose?: "claim-v1" | "proof-v1" | "checkout-v1") =>
      verifyClaim({ publicKeys: [PUB], ...base, signature, purpose });
    expect(v(PROOF_SIG, "proof-v1")).toBe(true);
    expect(v(PROOF_SIG, "checkout-v1")).toBe(false);
    expect(v(PROOF_SIG)).toBe(false);
    expect(v(CHECKOUT_SIG, "checkout-v1")).toBe(true);
    expect(v(CHECKOUT_SIG, "proof-v1")).toBe(false);
    expect(v(SIG, "proof-v1")).toBe(false);
    expect(v(SIG, "claim-v1")).toBe(true);
  });
  it("refuses a purpose it does not know", () => {
    expect(() => claimMessage({ ...base, purpose: "other" as never })).toThrow(/purpose/);
  });
});
