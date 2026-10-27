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
