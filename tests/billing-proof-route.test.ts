import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireActor: vi.fn(),
  writeAudit: vi.fn(),
  tables: {} as Record<string, Record<string, unknown>[]>,
}));

vi.mock("@/lib/auth/guards", () => {
  class AccessError extends Error {
    constructor(
      message: string,
      readonly code: string
    ) {
      super(message);
    }
  }
  return { AccessError, requireActor: mocks.requireActor };
});
vi.mock("@/lib/audit", () => ({ writeAudit: mocks.writeAudit }));
vi.mock("@/lib/env", () => ({
  env: {
    PROOF_R2_ENDPOINT: "https://acct.r2.cloudflarestorage.com",
    PROOF_R2_BUCKET: "school-proofs",
    PROOF_R2_ACCESS_KEY_ID: "AKIAEXAMPLE1234",
    PROOF_R2_SECRET_ACCESS_KEY: "secret-secret-secret-1234",
  },
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (table: string) => {
      let rows = [...(mocks.tables[table] ?? [])];
      const b: Record<string, unknown> = {
        select: () => b,
        eq: (c: string, v: unknown) => ((rows = rows.filter((r) => r[c] === v)), b),
        maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
      };
      return b;
    },
  }),
}));

import { GET } from "@/app/billing/proof/[claimId]/route";
import { AccessError } from "@/lib/auth/guards";

const CLAIM = "00000000-0000-4000-8000-000000000030";
const SCHOOL = "00000000-0000-4000-8000-000000000010";
const PATH = "proofs/greenfield/123e4567-e89b-42d3-a456-426614174000.jpg";
const call = (id: string) =>
  GET(new Request("http://x") as never, { params: Promise.resolve({ claimId: id }) });

beforeEach(() => {
  mocks.requireActor
    .mockReset()
    .mockResolvedValue({ id: "u", email: "f@example.com", role: "finance" });
  mocks.writeAudit.mockReset().mockResolvedValue(undefined);
  mocks.tables = {
    payment_claims: [{ id: CLAIM, school_id: SCHOOL, proof_path: PATH }],
  };
});

describe("GET /billing/proof/[claimId]", () => {
  it("redirects to a two-minute link and audits the view first", async () => {
    const res = await call(CLAIM);
    expect(res.status).toBe(302);
    const to = new URL(res.headers.get("location")!);
    expect(to.host).toBe("acct.r2.cloudflarestorage.com");
    expect(to.pathname).toBe(`/school-proofs/${PATH}`);
    expect(to.searchParams.get("X-Amz-Expires")).toBe("120");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(mocks.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ email: "f@example.com" }),
      {
        action: "claim.proof_view",
        schoolId: SCHOOL,
        details: { claim_id: CLAIM, proof_path: PATH },
      }
    );
  });

  it("is for owner and finance, answering 401 or 403 and revealing nothing", async () => {
    mocks.requireActor.mockRejectedValueOnce(new AccessError("Sign in.", "signed_out"));
    expect((await call(CLAIM)).status).toBe(401);
    mocks.requireActor.mockRejectedValueOnce(new AccessError("No.", "forbidden"));
    const res = await call(CLAIM);
    expect(res.status).toBe(403);
    expect(res.headers.get("location")).toBeNull();
    expect(JSON.stringify(mocks.requireActor.mock.calls[0][0])).toBe('["owner","finance"]');
    expect(mocks.writeAudit).not.toHaveBeenCalled();
  });

  it("answers 404 for a bad id, an unknown claim, or a claim without a proof", async () => {
    expect((await call("nope")).status).toBe(404);
    expect((await call("00000000-0000-4000-8000-000000000099")).status).toBe(404);
    mocks.tables.payment_claims[0].proof_path = null;
    const res = await call(CLAIM);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("This claim has no proof attached.");
  });

  it("does not hand out a link when the view cannot be audited", async () => {
    mocks.writeAudit.mockRejectedValueOnce(new Error("audit down"));
    const res = await call(CLAIM);
    expect(res.status).toBe(500);
    expect(res.headers.get("location")).toBeNull();
  });

  it("refuses a stored path that is not a proof path rather than signing it", async () => {
    mocks.tables.payment_claims[0].proof_path = "../../secrets.txt";
    const res = await call(CLAIM);
    expect(res.status).toBe(500);
    expect(res.headers.get("location")).toBeNull();
    expect(mocks.writeAudit).not.toHaveBeenCalled();
  });
});
