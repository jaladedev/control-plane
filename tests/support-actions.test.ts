import { beforeEach, describe, expect, it, vi } from "vitest";
import { verifyImpersonationToken } from "@/lib/impersonation";

const SECRET = "greenfield-secret-at-least-32-characters-long";

const mocks = vi.hoisted(() => ({
  requireActor: vi.fn(),
  withAudit: vi.fn(),
  single: vi.fn(),
  env: { SCHOOL_SIGNING_SECRETS: undefined as string | undefined },
}));

vi.mock("@/lib/env", () => ({ env: mocks.env }));
vi.mock("@/lib/auth/guards", () => ({ requireActor: mocks.requireActor }));
vi.mock("@/lib/audit", () => ({ withAudit: mocks.withAudit }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => ({
    from: () => ({ select: () => ({ eq: () => ({ single: mocks.single }) }) }),
  })),
}));

import { createSupportLink } from "@/lib/actions/support";

const schoolId = "22222222-2222-4222-8222-222222222222";
const support = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "s@example.com",
  role: "support",
};
const now = new Date("2026-10-23T10:00:00Z");
const school = (patch = {}) => ({
  id: schoolId,
  slug: "greenfield",
  status: "active",
  hostnames: ["Greenfield.Example.com", "second.example.com"],
  ...patch,
});

let audited: Array<{ action: string; details?: Record<string, unknown> }>;
let order: string[];

beforeEach(() => {
  Object.values(mocks).forEach((m) => typeof m === "function" && m.mockReset());
  mocks.env.SCHOOL_SIGNING_SECRETS = JSON.stringify({ greenfield: SECRET });
  audited = [];
  order = [];
  mocks.requireActor.mockResolvedValue(support);
  mocks.withAudit.mockImplementation(async (_actor, entry, fn) => {
    audited.push(entry);
    order.push("audit");
    return fn();
  });
  mocks.single.mockResolvedValue({ data: school(), error: null });
});

describe("createSupportLink", () => {
  it("is limited to owner and support", async () => {
    await createSupportLink(schoolId, now);
    expect(mocks.requireActor).toHaveBeenCalledWith(["owner", "support"]);
  });

  it("returns a link on the first hostname whose token the school would accept", async () => {
    const { url, expiresAt } = await createSupportLink(schoolId, now);
    const parsed = new URL(url);
    expect(parsed.origin).toBe("https://greenfield.example.com");
    expect(parsed.pathname).toBe("/api/impersonate");
    const verified = verifyImpersonationToken(parsed.searchParams.get("token")!, {
      secret: SECRET,
      school: "greenfield",
      now,
    });
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.claims.by).toBe("s@example.com");
      expect(verified.claims.exp - verified.claims.iat).toBe(300);
    }
    expect(expiresAt).toBe("2026-10-23T10:05:00.000Z");
  });

  it("audits first, names the link by its id, and never records the token", async () => {
    const { url } = await createSupportLink(schoolId, now);
    const token = new URL(url).searchParams.get("token")!;
    const claims = JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString());
    expect(order).toEqual(["audit"]);
    expect(audited[0].action).toBe("support.link");
    expect(audited[0].details).toMatchObject({
      slug: "greenfield",
      hostname: "greenfield.example.com",
      link_id: claims.jti,
    });
    expect(JSON.stringify(audited)).not.toContain(token);
  });

  it("refuses, without an audit row, when nothing can be signed or reached", async () => {
    mocks.env.SCHOOL_SIGNING_SECRETS = undefined;
    await expect(createSupportLink(schoolId, now)).rejects.toThrow(
      /SCHOOL_SIGNING_SECRETS is not set/
    );
    mocks.env.SCHOOL_SIGNING_SECRETS = JSON.stringify({ other: SECRET });
    await expect(createSupportLink(schoolId, now)).rejects.toThrow(
      /No signing secret for "greenfield"/
    );
    mocks.env.SCHOOL_SIGNING_SECRETS = JSON.stringify({ greenfield: "too-short" });
    await expect(createSupportLink(schoolId, now)).rejects.toThrow(/at least 32/);
    mocks.single.mockResolvedValue({ data: school({ hostnames: [] }), error: null });
    mocks.env.SCHOOL_SIGNING_SECRETS = JSON.stringify({ greenfield: SECRET });
    await expect(createSupportLink(schoolId, now)).rejects.toThrow(/hostname/);
    mocks.single.mockResolvedValue({ data: school({ hostnames: ["localhost"] }), error: null });
    await expect(createSupportLink(schoolId, now)).rejects.toThrow(/not a valid hostname/);
    expect(audited).toEqual([]);
  });

  it("refuses an archived or missing school, and an actor with no email", async () => {
    mocks.single.mockResolvedValue({ data: school({ status: "archived" }), error: null });
    await expect(createSupportLink(schoolId, now)).rejects.toThrow(/archived/);
    mocks.single.mockResolvedValue({ data: null, error: { message: "none" } });
    await expect(createSupportLink(schoolId, now)).rejects.toThrow(/does not exist/);
    mocks.single.mockResolvedValue({ data: school(), error: null });
    mocks.requireActor.mockResolvedValue({ ...support, email: "" });
    await expect(createSupportLink(schoolId, now)).rejects.toThrow(/no email/);
    expect(audited).toEqual([]);
  });

  it("passes on a role refusal without touching the database", async () => {
    mocks.requireActor.mockRejectedValue(new Error("Your role cannot do this."));
    await expect(createSupportLink(schoolId, now)).rejects.toThrow(/role cannot/);
    expect(mocks.single).not.toHaveBeenCalled();
  });
});
