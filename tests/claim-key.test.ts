import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { publicKeyFromClaimSeed } from "@/lib/provision/claim-key";

// The same encoding school_app's `npm run claim-key` prints: base64url of the raw 32 bytes.
function pair() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    seed: privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32).toString("base64url"),
    pub: publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64url"),
  };
}

describe("publicKeyFromClaimSeed", () => {
  it("derives exactly the public key that claim-key prints", () => {
    for (let i = 0; i < 5; i++) {
      const k = pair();
      expect(publicKeyFromClaimSeed(k.seed)).toBe(k.pub);
    }
  });

  it("gives a key the database will accept (43 URL-safe characters)", () => {
    expect(publicKeyFromClaimSeed(pair().seed)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it.each([
    [""],
    ["short"],
    ["a".repeat(42)],
    ["a".repeat(44)],
    ["!".repeat(43)],
    [`${"a".repeat(42)}=`],
  ])("returns null for %j", (bad) => expect(publicKeyFromClaimSeed(bad)).toBeNull());
});
