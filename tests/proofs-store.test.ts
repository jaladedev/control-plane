import { describe, expect, it } from "vitest";
import {
  PROOF_MAX_BYTES,
  UPLOAD_LINK_SECONDS,
  VIEW_LINK_SECONDS,
  isProofPathFor,
  proofStoreFrom,
} from "@/lib/storage/proofs";

const cfg = {
  endpoint: "https://acct.r2.cloudflarestorage.com",
  bucket: "school-proofs",
  accessKeyId: "AKIAEXAMPLE1234",
  secretAccessKey: "secret-secret-secret-1234",
};
const store = proofStoreFrom(cfg)!;
const NOW = new Date("2026-10-25T12:00:00Z");
const UUID = "123e4567-e89b-42d3-a456-426614174000";

describe("proofStoreFrom", () => {
  it("is absent without a configuration", () => {
    expect(proofStoreFrom(null)).toBeNull();
  });

  it("makes an upload link that signs the exact type and length and lasts five minutes", () => {
    const link = store.upload("greenfield", "application/pdf", 4096, NOW);
    expect(isProofPathFor(link.path, "greenfield")).toBe(true);
    const url = new URL(link.url);
    expect(url.searchParams.get("X-Amz-Expires")).toBe(String(UPLOAD_LINK_SECONDS));
    expect(url.searchParams.get("X-Amz-Date")).toBe("20261025T120000Z");
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("content-length;content-type;host");
    expect(link.headers).toEqual({ "content-type": "application/pdf", "content-length": "4096" });
  });

  it("refuses a type or size it should never sign", () => {
    expect(() => store.upload("greenfield", "text/html", 100, NOW)).toThrow(/JPEG, PNG or WebP/);
    expect(() => store.upload("greenfield", "image/png", 0, NOW)).toThrow(/between 1 byte/);
    expect(() => store.upload("greenfield", "image/png", PROOF_MAX_BYTES + 1, NOW)).toThrow(
      /between 1 byte/
    );
    expect(() => store.upload("greenfield", "image/png", 1.5, NOW)).toThrow();
  });

  it("makes a two-minute view link, and only for a path it could have made", () => {
    const path = `proofs/greenfield/${UUID}.png`;
    const url = new URL(store.view(path, NOW));
    expect(url.pathname).toBe(`/school-proofs/${path}`);
    expect(url.searchParams.get("X-Amz-Expires")).toBe(String(VIEW_LINK_SECONDS));
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
    for (const bad of ["../x.png", "proofs/a.jpg", `proofs/x/../${UUID}.png`, "", `${UUID}.png`]) {
      expect(() => store.view(bad, NOW)).toThrow(/not a proof path/);
    }
  });
});

describe("isProofPathFor", () => {
  it("accepts only that school's prefix with a real uuid and an allowed extension", () => {
    expect(isProofPathFor(`proofs/greenfield/${UUID}.jpg`, "greenfield")).toBe(true);
    expect(isProofPathFor(`proofs/greenfield/${UUID}.pdf`, "greenfield")).toBe(true);
    expect(isProofPathFor(`proofs/greenfield/${UUID}.jpg`, "other")).toBe(false);
    expect(isProofPathFor(`proofs/green/${UUID}.jpg`, "greenfield")).toBe(false);
    expect(isProofPathFor(`proofs/greenfield/${UUID}.exe`, "greenfield")).toBe(false);
    expect(isProofPathFor(`proofs/greenfield/${UUID}.jpg/x`, "greenfield")).toBe(false);
    expect(isProofPathFor(`proofs/greenfield/../other/${UUID}.jpg`, "greenfield")).toBe(false);
    expect(isProofPathFor("proofs/greenfield/a.jpg", "greenfield")).toBe(false);
    expect(isProofPathFor(`/proofs/greenfield/${UUID}.jpg`, "greenfield")).toBe(false);
  });
});
