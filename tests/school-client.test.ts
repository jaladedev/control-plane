import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  env: { SCHOOL_SERVICE_KEYS: undefined as string | undefined },
  createClient: vi.fn((..._args: unknown[]) => ({ marker: "client" })),
}));
vi.mock("@/lib/env", () => ({ env: mocks.env }));
vi.mock("@supabase/supabase-js", () => ({ createClient: mocks.createClient }));

import { createSchoolClient } from "@/lib/school-client";

const REF = "abcdefghijklmnopqrst";

beforeEach(() => {
  mocks.createClient.mockClear();
  mocks.env.SCHOOL_SERVICE_KEYS = JSON.stringify({ greenfield: "key-g", bluefield: "key-b" });
});

describe("createSchoolClient", () => {
  it("connects to the school's own project with that school's key", () => {
    createSchoolClient("greenfield", REF);
    expect(mocks.createClient).toHaveBeenCalledWith(
      `https://${REF}.supabase.co`,
      "key-g",
      expect.objectContaining({ auth: expect.objectContaining({ persistSession: false }) })
    );
  });

  it("needs a project ref", () => {
    expect(() => createSchoolClient("greenfield", null)).toThrow(/project ref/);
  });

  it.each(["has.dots.example.com", "UPPER", "short", "a/b"])("refuses the ref %j", (ref) => {
    expect(() => createSchoolClient("greenfield", ref)).toThrow(/looks wrong/);
  });

  it("explains a missing SCHOOL_SERVICE_KEYS", () => {
    mocks.env.SCHOOL_SERVICE_KEYS = undefined;
    expect(() => createSchoolClient("greenfield", REF)).toThrow(/SCHOOL_SERVICE_KEYS is not set/);
  });

  it("explains malformed JSON without echoing the keys", () => {
    mocks.env.SCHOOL_SERVICE_KEYS = "{not json key-g";
    expect(() => createSchoolClient("greenfield", REF)).toThrow(/must be JSON/);
    try {
      createSchoolClient("greenfield", REF);
    } catch (e) {
      expect(String(e)).not.toContain("key-g");
    }
  });

  it("explains a school with no key", () => {
    expect(() => createSchoolClient("redfield", REF)).toThrow(/No service key for "redfield"/);
  });

  it("never uses another school's key", () => {
    createSchoolClient("bluefield", REF);
    expect(mocks.createClient.mock.calls[0][1]).toBe("key-b");
  });
});
