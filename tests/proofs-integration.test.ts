import { describe, expect, it, beforeAll } from "vitest";
import { proofStoreFrom } from "@/lib/storage/proofs";

// Real uploads and downloads with the presigned links, against a local S3-compatible
// server (for example `moto_server -H 127.0.0.1 -p 5555`). Needs BACKUP_TEST_S3_ENDPOINT.
// The server does not check signatures, see the note at the end. RUNNER_TEST_REQUIRED=1 turns a skip into a failure, as for the other integration tests.
const ENDPOINT = process.env.BACKUP_TEST_S3_ENDPOINT;
const BUCKET = "proof-integration-test";

describe.skipIf(!ENDPOINT)("proofs against a real S3 server", () => {
  const store = proofStoreFrom({
    endpoint: ENDPOINT ?? "http://127.0.0.1:5555",
    bucket: BUCKET,
    accessKeyId: "testing",
    secretAccessKey: "testing-testing-testing",
  })!;

  beforeAll(async () => {
    const res = await fetch(`${ENDPOINT}/${BUCKET}`, { method: "PUT" });
    expect([200, 409]).toContain(res.status);
  });

  const photo = Buffer.from(
    "\xff\xd8\xff\xe0fake jpeg bytes for the test".padEnd(300, "x"),
    "latin1"
  );

  it("lets the school's server upload with the link and staff read it back with theirs", async () => {
    const link = store.upload("greenfield", "image/jpeg", photo.length);
    const put = await fetch(link.url, {
      method: "PUT",
      headers: { "content-type": "image/jpeg" },
      body: photo,
    });
    expect(put.status).toBe(200);

    const got = await fetch(store.view(link.path));
    expect(got.status).toBe(200);
    expect(Buffer.from(await got.arrayBuffer()).equals(photo)).toBe(true);
    expect(got.headers.get("content-type")).toBe("image/jpeg");
  });

  // moto does not verify signatures or expiry, so this test proves the flow (the link
  // shape, the signed headers, where the bytes land) and not the signature itself. That
  // is checked against AWS's own published example in presign.test.ts.
});
