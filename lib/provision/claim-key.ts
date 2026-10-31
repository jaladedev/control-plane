import { createPrivateKey, createPublicKey } from "node:crypto";

// A school's CLAIM_SIGNING_KEY is the base64url of the raw 32-byte Ed25519 seed
// (school_app's `npm run claim-key`). Its public half is what the control plane
// stores, in the same encoding. Deriving one from the other lets the worker check
// that a key about to be put on a school's server is one the control plane will
// accept, BEFORE the school starts signing with it.

// PKCS#8 wrapper of an Ed25519 seed: the 16 fixed bytes, then the 32-byte seed.
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

/** The base64url public key for a base64url private seed, or null if it is not a valid seed. */
export function publicKeyFromClaimSeed(seed: string): string | null {
  if (!/^[A-Za-z0-9_-]{43}$/.test(seed)) return null;
  const raw = Buffer.from(seed, "base64url");
  if (raw.length !== 32) return null;
  try {
    const key = createPrivateKey({
      key: Buffer.concat([PKCS8_PREFIX, raw]),
      format: "der",
      type: "pkcs8",
    });
    const spki = createPublicKey(key).export({ format: "der", type: "spki" });
    return spki.subarray(-32).toString("base64url");
  } catch {
    return null;
  }
}
