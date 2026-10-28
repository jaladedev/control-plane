import { createHash, createHmac } from "node:crypto";

// AWS Signature Version 4 query-string signing ("presigned URLs"), which is what
// Cloudflare R2 and every S3-compatible store accepts. Written out here, with no
// SDK, so that the web app can hand out a short-lived link without carrying a
// large dependency. The test checks it against the example AWS publishes.

const hmac = (key: string | Buffer, data: string) =>
  createHmac("sha256", key).update(data).digest();
const sha256Hex = (data: string) => createHash("sha256").update(data).digest("hex");

// RFC 3986: encodeURIComponent leaves ! ' ( ) * alone, AWS wants them encoded.
const enc = (s: string) =>
  encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );

const encPath = (path: string) => path.split("/").map(enc).join("/");

export type PresignInput = {
  method: "GET" | "PUT";
  /** Host only, e.g. "abc123.r2.cloudflarestorage.com" (with the port, if it is not the default). */
  host: string;
  /** Defaults to https. Plain http is only for a local test server. */
  scheme?: "https" | "http";
  /** Path as it is on the wire, starting with "/", not yet encoded. */
  path: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  expiresSeconds: number;
  now: Date;
  /** Headers the caller must send exactly as given (besides host). Names in any case. */
  signedHeaders?: Record<string, string>;
  /** Extra query parameters that become part of the signature (e.g. response-content-type). */
  query?: Record<string, string>;
};

export function presignUrl(p: PresignInput): string {
  if (!Number.isInteger(p.expiresSeconds) || p.expiresSeconds < 1 || p.expiresSeconds > 604_800) {
    throw new Error("A presigned link must last between 1 second and 7 days.");
  }
  const stamp = p.now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  const date = stamp.slice(0, 8);
  const scope = `${date}/${p.region}/s3/aws4_request`;

  const headers: Record<string, string> = { host: p.host };
  for (const [k, v] of Object.entries(p.signedHeaders ?? {})) {
    headers[k.toLowerCase()] = v.trim().replace(/\s+/g, " ");
  }
  const names = Object.keys(headers).sort();
  const signedHeaders = names.join(";");

  const query: Record<string, string> = {
    ...p.query,
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${p.accessKeyId}/${scope}`,
    "X-Amz-Date": stamp,
    "X-Amz-Expires": String(p.expiresSeconds),
    "X-Amz-SignedHeaders": signedHeaders,
  };
  const canonicalQuery = Object.keys(query)
    .sort()
    .map((k) => `${enc(k)}=${enc(query[k])}`)
    .join("&");

  const canonicalPath = encPath(p.path);
  const canonicalRequest = [
    p.method,
    canonicalPath,
    canonicalQuery,
    names.map((n) => `${n}:${headers[n]}\n`).join(""),
    signedHeaders,
    "UNSIGNED-PAYLOAD",
  ].join("\n");

  const stringToSign = ["AWS4-HMAC-SHA256", stamp, scope, sha256Hex(canonicalRequest)].join("\n");
  const key = hmac(
    hmac(hmac(hmac(`AWS4${p.secretAccessKey}`, date), p.region), "s3"),
    "aws4_request"
  );
  const signature = createHmac("sha256", key).update(stringToSign).digest("hex");
  return `${p.scheme ?? "https"}://${p.host}${canonicalPath}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}
