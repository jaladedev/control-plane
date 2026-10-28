import { describe, expect, it } from "vitest";
import { presignUrl } from "@/lib/storage/presign";

// The worked example from AWS's documentation ("Authenticating Requests: Using Query
// Parameters"): a signed GET for examplebucket/test.txt, valid for 24 hours.
const AWS = {
  method: "GET" as const,
  host: "examplebucket.s3.amazonaws.com",
  path: "/test.txt",
  region: "us-east-1",
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  expiresSeconds: 86_400,
  now: new Date("2013-05-24T00:00:00Z"),
};

describe("presignUrl", () => {
  it("matches the signature AWS publishes for its own example", () => {
    expect(presignUrl(AWS)).toBe(
      "https://examplebucket.s3.amazonaws.com/test.txt" +
        "?X-Amz-Algorithm=AWS4-HMAC-SHA256" +
        "&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request" +
        "&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host" +
        "&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404"
    );
  });

  it("signs the headers the uploader must send, in sorted lower case", () => {
    const url = new URL(
      presignUrl({
        ...AWS,
        method: "PUT",
        signedHeaders: { "Content-Type": "image/png", "Content-Length": "1234" },
      })
    );
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("content-length;content-type;host");
  });

  it("changes the signature when anything signed changes", () => {
    const sig = (over: Partial<Parameters<typeof presignUrl>[0]>) =>
      new URL(presignUrl({ ...AWS, ...over })).searchParams.get("X-Amz-Signature");
    const base = sig({});
    expect(sig({ path: "/test2.txt" })).not.toBe(base);
    expect(sig({ method: "PUT" })).not.toBe(base);
    expect(sig({ expiresSeconds: 60 })).not.toBe(base);
    expect(sig({ now: new Date("2013-05-24T00:00:01Z") })).not.toBe(base);
    expect(sig({ signedHeaders: { "content-length": "5" } })).not.toBe(base);
    expect(sig({ query: { "response-content-type": "application/pdf" } })).not.toBe(base);
    expect(sig({ secretAccessKey: "other" })).not.toBe(base);
    expect(sig({})).toBe(base);
  });

  it("encodes the path and extra query values the way AWS expects", () => {
    const url = presignUrl({
      ...AWS,
      path: "/bucket/proofs/a b/c(1).png",
      query: { "response-content-disposition": 'inline; filename="x y.png"' },
    });
    expect(url).toContain("/bucket/proofs/a%20b/c%281%29.png?");
    expect(url).toContain("response-content-disposition=inline%3B%20filename%3D%22x%20y.png%22");
  });

  it("refuses a lifetime outside 1 second to 7 days", () => {
    for (const expiresSeconds of [0, -5, 1.5, 604_801]) {
      expect(() => presignUrl({ ...AWS, expiresSeconds })).toThrow(/between 1 second and 7 days/);
    }
  });
});
