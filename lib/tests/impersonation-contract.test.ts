import { describe, expect, it } from "vitest";
import { signImpersonationToken, verifyImpersonationToken } from "@/lib/impersonation";

// The same literal token is asserted in school_app's tests/impersonation.test.ts.
// If either side changes the link format, its copy of this test fails.
const SECRET = "contract-vector-secret-0123456789abcdef";
const VECTOR =
  "eyJ2IjoxLCJzY2giOiJncmVlbmZpZWxkIiwiYnkiOiJzdXBwb3J0QGV4YW1wbGUuY29tIiwianRpIjoiMDAwMDAwMDAtMDAwMC00MDAwLTgwMDAtMDAwMDAwMDAwMDAxIiwiaWF0IjoxNzkyNzQ5NjAwLCJleHAiOjE3OTI3NDk5MDB9.NKQOOxMe-ECa300N7sEz7y1ST6GfyG22kBQNcwnFyQk";
const now = new Date("2026-10-23T10:00:00Z");

describe("support link format (shared with school_app)", () => {
  it("signs the agreed token byte for byte", () => {
    expect(
      signImpersonationToken({
        secret: SECRET,
        school: "greenfield",
        by: "support@example.com",
        ttlSeconds: 300,
        now,
        jti: "00000000-0000-4000-8000-000000000001",
      })
    ).toBe(VECTOR);
  });

  it("verifies for the right school and secret, and not otherwise", () => {
    expect(verifyImpersonationToken(VECTOR, { secret: SECRET, school: "greenfield", now }).ok).toBe(
      true
    );
    expect(verifyImpersonationToken(VECTOR, { secret: SECRET, school: "other", now })).toEqual({
      ok: false,
      reason: "wrong_school",
    });
    expect(
      verifyImpersonationToken(VECTOR, { secret: "x".repeat(40), school: "greenfield", now })
    ).toEqual({ ok: false, reason: "bad_signature" });
  });
});
