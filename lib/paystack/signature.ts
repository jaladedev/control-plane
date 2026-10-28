import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Paystack signs the exact bytes of every webhook with your secret key
 * (HMAC-SHA512, hex) and sends it in the x-paystack-signature header.
 */
export function paystackSignature(rawBody: string | Buffer, secret: string): string {
  return createHmac("sha512", secret).update(rawBody).digest("hex");
}

export function verifyPaystackSignature(
  rawBody: string | Buffer,
  header: string | null | undefined,
  secret: string
): boolean {
  if (!header || !/^[0-9a-f]{128}$/i.test(header)) return false;
  const expected = Buffer.from(paystackSignature(rawBody, secret), "hex");
  const given = Buffer.from(header, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}
