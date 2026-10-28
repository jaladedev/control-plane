import { describe, expect, it, vi } from "vitest";
import { PROOF_LIMITS, handleProofRequest, type ProofDeps } from "@/lib/billing/proof-endpoint";
import { generateClaimKeyPair, signClaim } from "@/lib/billing/claim-signature";
import { isProofPathFor, proofStoreFrom } from "@/lib/storage/proofs";

const keys = generateClaimKeyPair();
const NOW = new Date("2026-10-25T12:00:00Z");
const TS = Math.floor(NOW.getTime() / 1000);
const store = proofStoreFrom({
  endpoint: "https://acct.r2.cloudflarestorage.com",
  bucket: "school-proofs",
  accessKeyId: "AKIAEXAMPLE1234",
  secretAccessKey: "secret-secret-secret-1234",
});
const body = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ content_type: "image/jpeg", size_bytes: 250_000, ...over });

function setup(over: Partial<ProofDeps> = {}, status = "active") {
  const deps: ProofDeps = {
    findSchool: vi.fn(async (slug: string) =>
      slug === "greenfield" ? { id: "school-1", status } : null
    ),
    publicKeys: vi.fn(async () => [keys.publicKey]),
    rateLimit: vi.fn(async () => true),
    store,
    audit: vi.fn(async () => {}),
    ...over,
  };
  const send = (rawBody: string, purpose: "proof-v1" | "claim-v1" = "proof-v1") =>
    handleProofRequest(
      {
        slug: "greenfield",
        timestamp: String(TS),
        signature: signClaim({
          privateKey: keys.privateKey,
          slug: "greenfield",
          timestamp: TS,
          body: rawBody,
          purpose,
        }),
        rawBody,
        ip: "203.0.113.7",
      },
      deps,
      NOW
    );
  return { deps, send };
}

describe("handleProofRequest", () => {
  it("gives a signed upload link and a path under the school's own prefix, and audits it", async () => {
    const { deps, send } = setup();
    const res = await send(body());
    expect(res.status).toBe(200);
    const b = res.body as {
      proof_path: string;
      upload_url: string;
      upload_headers: Record<string, string>;
      expires_in: number;
    };
    expect(isProofPathFor(b.proof_path, "greenfield")).toBe(true);
    expect(b.proof_path.endsWith(".jpg")).toBe(true);
    expect(b.upload_headers).toEqual({ "content-type": "image/jpeg", "content-length": "250000" });
    expect(b.expires_in).toBe(300);
    const url = new URL(b.upload_url);
    expect(url.host).toBe("acct.r2.cloudflarestorage.com");
    expect(url.pathname).toBe(`/school-proofs/${b.proof_path}`);
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("content-length;content-type;host");
    expect(deps.audit).toHaveBeenCalledWith("claim.proof_link", "school-1", {
      proof_path: b.proof_path,
      content_type: "image/jpeg",
      size_bytes: 250_000,
    });
  });

  it("makes a different path every time", async () => {
    const { send } = setup();
    const a = (await send(body())).body.proof_path;
    const b = (await send(body())).body.proof_path;
    expect(a).not.toBe(b);
  });

  it("refuses a request signed for a claim: a signature is good for one purpose only", async () => {
    const { deps, send } = setup();
    const res = await send(body(), "claim-v1");
    expect(res).toEqual({ status: 401, body: { ok: false, error: "Request rejected." } });
    expect(deps.audit).not.toHaveBeenCalled();
  });

  it("counts its own buckets, not the claim ones", async () => {
    const { deps, send } = setup();
    await send(body());
    expect(deps.rateLimit).toHaveBeenCalledWith(
      "proof:ip:203.0.113.7",
      PROOF_LIMITS.perAddress.windowSeconds,
      PROOF_LIMITS.perAddress.max
    );
    expect(deps.rateLimit).toHaveBeenCalledWith(
      "proof:school:school-1",
      PROOF_LIMITS.perSchool.windowSeconds,
      PROOF_LIMITS.perSchool.max
    );
  });

  it("answers 429 when the school asks for too many links", async () => {
    const { deps, send } = setup({
      rateLimit: vi.fn(async (bucket: string) => !bucket.startsWith("proof:school:")),
    });
    expect((await send(body())).status).toBe(429);
    expect(deps.audit).not.toHaveBeenCalled();
  });

  it("refuses types that are not photos or PDFs, sizes out of range, and unknown fields", async () => {
    const { deps, send } = setup();
    for (const bad of [
      { content_type: "text/html" },
      { content_type: "image/svg+xml" },
      { content_type: "application/x-msdownload" },
      { size_bytes: 0 },
      { size_bytes: 5 * 1024 * 1024 + 1 },
      { size_bytes: 1.5 },
      { size_bytes: "100" },
      { filename: "../../etc/passwd" },
    ]) {
      const res = await send(body(bad));
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    expect((await send("not json")).status).toBe(400);
    expect(deps.audit).not.toHaveBeenCalled();
  });

  it("accepts every allowed type and gives it the matching extension", async () => {
    const { send } = setup();
    for (const [type, ext] of [
      ["image/jpeg", "jpg"],
      ["image/png", "png"],
      ["image/webp", "webp"],
      ["application/pdf", "pdf"],
    ]) {
      const res = await send(body({ content_type: type }));
      expect(res.status).toBe(200);
      expect(String(res.body.proof_path).endsWith(`.${ext}`)).toBe(true);
    }
  });

  it("says plainly that uploads are unavailable when no bucket is set up, and audits nothing", async () => {
    const { deps, send } = setup({ store: null });
    const res = await send(body());
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/not available yet/);
    expect(deps.audit).not.toHaveBeenCalled();
  });

  it("refuses an archived school", async () => {
    const { send } = setup({}, "archived");
    expect((await send(body())).status).toBe(403);
  });
});
