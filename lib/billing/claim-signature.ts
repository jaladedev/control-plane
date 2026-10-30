import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from "node:crypto";

// How a school proves a payment claim is its own. Ed25519: the school keeps the
// private key (its env file) and the control plane stores only the PUBLIC key, so
// nothing the control plane holds can be used to forge a claim.
//
// Keys travel as base64url of the raw 32 bytes. The signature covers a message
// binding the school, the moment and the exact request body:
//
//   <purpose> \n <school slug> \n <unix seconds> \n <sha256 hex of the body bytes>
//
// The purpose is "claim-v1" for a payment claim, "proof-v1" for asking to upload a
// proof of payment, "checkout-v1" for starting a card payment and "invoices-v1" for
// asking which invoices are open. It is part of
// what is signed, so a request signed for one purpose is worthless for another.
// A signed request is only accepted within CLAIM_MAX_SKEW_SECONDS of now, and a
// replay inside that window is harmless because a claim is idempotent on its
// client_ref. This file is kept identical to school_app's lib/controlPlaneClaim.ts
// (the school signs, the control plane verifies); both repos assert the same
// literal signature in their tests.

export const CLAIM_MAX_SKEW_SECONDS = 300;

export const SIGNATURE_PURPOSES = ["claim-v1", "proof-v1", "checkout-v1", "invoices-v1"] as const;
export type SignaturePurpose = (typeof SIGNATURE_PURPOSES)[number];

const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const KEY_B64URL = /^[A-Za-z0-9_-]{43}$/;

export const isKeyEncoding = (value: string) => KEY_B64URL.test(value);

export function claimMessage(p: {
  slug: string;
  timestamp: number;
  body: string | Buffer;
  purpose?: SignaturePurpose;
}): string {
  const purpose = p.purpose ?? "claim-v1";
  if (!SIGNATURE_PURPOSES.includes(purpose)) throw new Error("Unknown signature purpose.");
  const digest = createHash("sha256").update(p.body).digest("hex");
  return [purpose, p.slug, String(p.timestamp), digest].join("\n");
}

export function generateClaimKeyPair(): { privateKey: string; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
  const pub = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  return { privateKey: seed.toString("base64url"), publicKey: pub.toString("base64url") };
}

export function signClaim(p: {
  privateKey: string;
  slug: string;
  timestamp: number;
  body: string | Buffer;
  purpose?: SignaturePurpose;
}): string {
  if (!KEY_B64URL.test(p.privateKey)) throw new Error("The claim signing key is not valid.");
  const key = createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, Buffer.from(p.privateKey, "base64url")]),
    format: "der",
    type: "pkcs8",
  });
  return sign(null, Buffer.from(claimMessage(p)), key).toString("base64url");
}

/** True when the signature is valid under ANY of the keys. Never throws on bad input. */
export function verifyClaim(p: {
  publicKeys: string[];
  slug: string;
  timestamp: number;
  body: string | Buffer;
  signature: string;
  purpose?: SignaturePurpose;
}): boolean {
  let sig: Buffer;
  try {
    sig = Buffer.from(p.signature, "base64url");
  } catch {
    return false;
  }
  if (sig.length !== 64) return false;
  const message = Buffer.from(claimMessage(p));
  for (const publicKey of p.publicKeys) {
    if (!KEY_B64URL.test(publicKey)) continue;
    try {
      const key = createPublicKey({
        key: Buffer.concat([SPKI_PREFIX, Buffer.from(publicKey, "base64url")]),
        format: "der",
        type: "spki",
      });
      if (verify(null, message, key, sig)) return true;
    } catch {
      // a malformed stored key is skipped, never fatal
    }
  }
  return false;
}

export const timestampFresh = (timestamp: number, now: Date) =>
  Number.isInteger(timestamp) &&
  Math.abs(now.getTime() / 1000 - timestamp) <= CLAIM_MAX_SKEW_SECONDS;
