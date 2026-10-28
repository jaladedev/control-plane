import { randomUUID } from "node:crypto";
import { presignUrl } from "@/lib/storage/presign";

// Proofs of payment (a photo or PDF of a transfer receipt) live in the control
// plane's OWN bucket, never a school's. A school never holds a credential for it:
// it asks, signed, for a short-lived upload link, sends the file straight to the
// bucket with it, and then names the returned path in its claim. Staff open a proof
// through a link that lives for two minutes.

export const PROOF_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "application/pdf": "pdf",
};
export const PROOF_MAX_BYTES = 5 * 1024 * 1024;
export const UPLOAD_LINK_SECONDS = 300;
export const VIEW_LINK_SECONDS = 120;

const PATH =
  /^proofs\/([a-z0-9][a-z0-9-]{0,40})\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp|pdf)$/;

/** True only for a path this module could have made for this school. */
export function isProofPathFor(path: string, slug: string): boolean {
  const m = PATH.exec(path);
  return m !== null && m[1] === slug;
}

export type ProofStoreConfig = {
  endpoint: string; // https://<account>.r2.cloudflarestorage.com
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
};

export type ProofStore = {
  /** A link the school's server PUTs the file to, and the path to put in the claim. */
  upload(
    slug: string,
    contentType: string,
    sizeBytes: number,
    now?: Date
  ): { path: string; url: string; headers: Record<string, string>; expiresIn: number };
  /** A link for staff to open one proof. */
  view(path: string, now?: Date): string;
};

export function proofStoreFrom(cfg: ProofStoreConfig | null): ProofStore | null {
  if (!cfg) return null;
  const endpoint = new URL(cfg.endpoint);
  const base = {
    host: endpoint.host,
    scheme: endpoint.protocol === "http:" ? ("http" as const) : ("https" as const),
    region: cfg.region ?? "auto",
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
  };
  const keyPath = (key: string) => `/${cfg.bucket}/${key}`;
  return {
    upload(slug, contentType, sizeBytes, now = new Date()) {
      const ext = PROOF_TYPES[contentType];
      if (!ext) throw new Error("Proofs can be a JPEG, PNG or WebP photo, or a PDF.");
      if (!Number.isInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > PROOF_MAX_BYTES) {
        throw new Error(`A proof must be between 1 byte and ${PROOF_MAX_BYTES / 1024 / 1024} MB.`);
      }
      const path = `proofs/${slug}/${randomUUID()}.${ext}`;
      // The type and the exact length are signed, so the bucket refuses any other file.
      const headers = { "content-type": contentType, "content-length": String(sizeBytes) };
      const url = presignUrl({
        ...base,
        method: "PUT",
        path: keyPath(path),
        expiresSeconds: UPLOAD_LINK_SECONDS,
        now,
        signedHeaders: headers,
      });
      return { path, url, headers, expiresIn: UPLOAD_LINK_SECONDS };
    },
    view(path, now = new Date()) {
      if (!PATH.test(path)) throw new Error("That is not a proof path.");
      return presignUrl({
        ...base,
        method: "GET",
        path: keyPath(path),
        expiresSeconds: VIEW_LINK_SECONDS,
        now,
        query: { "response-cache-control": "no-store" },
      });
    },
  };
}
