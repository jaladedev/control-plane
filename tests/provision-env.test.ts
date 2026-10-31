import { describe, expect, it } from "vitest";
import { buildSchoolEnvFile } from "@/lib/provision/env";
import { EnvSecrets } from "@/worker/secrets";

const good = {
  SUPABASE_URL: "https://abcdefgh.supabase.co",
  SUPABASE_ANON_KEY: "anon-key-value",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key-value",
  R2_ENDPOINT: "https://acct123.r2.cloudflarestorage.com",
  R2_BUCKET: "greenfield-files",
  R2_ACCESS_KEY_ID: "r2-key-id-value",
  R2_SECRET_ACCESS_KEY: "r2-secret-value-1234",
  IMPERSONATION_SIGNING_SECRET: "s".repeat(64),
};
const check = { slug: "greenfield", supabaseProjectRef: "abcdefgh", r2Bucket: "greenfield-files" };
type Check = { slug: string; supabaseProjectRef?: string | null; r2Bucket?: string | null };
const errorsOf = (values: Record<string, string> | undefined, c: Check = check) => {
  const r = buildSchoolEnvFile(values, c);
  return r.ok ? [] : r.errors;
};

describe("buildSchoolEnvFile", () => {
  it("writes SCHOOL_SLUG first, then the rest in order, one KEY=value per line", () => {
    const r = buildSchoolEnvFile(good, check);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const lines = r.file.trimEnd().split("\n");
    expect(lines[0]).toBe("SCHOOL_SLUG=greenfield");
    expect(lines.slice(1)).toEqual([...lines.slice(1)].sort());
    expect(lines.every((l) => /^[A-Z][A-Z0-9_]*=.+$/.test(l))).toBe(true);
    expect(r.file.endsWith("\n")).toBe(true);
  });

  it("sets SCHOOL_SLUG itself and accepts a matching one", () => {
    expect(errorsOf({ ...good, SCHOOL_SLUG: "greenfield" })).toEqual([]);
    expect(errorsOf({ ...good, SCHOOL_SLUG: "other" }).join(" ")).toMatch(/SCHOOL_SLUG/);
  });

  it("says which school has no settings, and what is missing", () => {
    expect(errorsOf(undefined).join(" ")).toMatch(/no entry for "greenfield"/);
    const { R2_BUCKET: _b, ...rest } = good;
    expect(errorsOf(rest).join(" ")).toMatch(/R2_BUCKET is missing/);
  });

  it("refuses a key the school app does not read, IMAGE_TAG included", () => {
    expect(errorsOf({ ...good, SUPABASE_ANNON_KEY: "x" }).join(" ")).toMatch(/SUPABASE_ANNON_KEY/);
    expect(errorsOf({ ...good, IMAGE_TAG: "a".repeat(40) }).join(" ")).toMatch(/IMAGE_TAG/);
  });

  it("refuses a value with a line break (it would become a second setting)", () => {
    expect(errorsOf({ ...good, RESEND_API_KEY: "re_x\nSCHOOL_SLUG=other" }).join(" ")).toMatch(
      /RESEND_API_KEY contains a line break/
    );
  });

  it("refuses another school's project or bucket", () => {
    expect(errorsOf({ ...good, SUPABASE_URL: "https://zzzzzzzz.supabase.co" }).join(" ")).toMatch(
      /not this school's project/
    );
    expect(errorsOf({ ...good, R2_BUCKET: "other-files" }).join(" ")).toMatch(
      /not this school's bucket/
    );
  });

  it("only compares with the registry when the registry says something", () => {
    const open = { slug: "greenfield", supabaseProjectRef: null, r2Bucket: null };
    expect(errorsOf({ ...good, R2_BUCKET: "anything" }, open)).toEqual([]);
  });

  it("wants an https project address and an R2 endpoint with no bucket in it", () => {
    expect(errorsOf({ ...good, SUPABASE_URL: "http://abcdefgh.supabase.co" }).join(" ")).toMatch(
      /https/
    );
    expect(
      errorsOf({
        ...good,
        R2_ENDPOINT: "https://acct123.r2.cloudflarestorage.com/greenfield-files",
      }).join(" ")
    ).toMatch(/must not include the bucket/);
  });

  it("wants a long signing secret", () => {
    expect(errorsOf({ ...good, IMPERSONATION_SIGNING_SECRET: "short" }).join(" ")).toMatch(
      /at least 32/
    );
  });

  it("wants the control plane address and claim key together", () => {
    expect(errorsOf({ ...good, CONTROL_PLANE_URL: "https://cp.example.com" }).join(" ")).toMatch(
      /together/
    );
    expect(
      errorsOf({ ...good, CONTROL_PLANE_URL: "https://cp.example.com", CLAIM_SIGNING_KEY: "k" })
    ).toEqual([]);
  });

  it("reports every problem at once and never repeats a value", () => {
    const errors = errorsOf({ ...good, SUPABASE_ANON_KEY: "", R2_BUCKET: "oops" });
    expect(errors.length).toBeGreaterThanOrEqual(2);
    expect(errors.join(" ")).not.toContain("r2-secret-value-1234");
  });
});

describe("EnvSecrets: school container settings", () => {
  const dbUrl = "postgres://postgres:databasePassw0rd@db.example.supabase.co:5432/postgres";
  const secrets = new EnvSecrets(
    JSON.stringify({ greenfield: dbUrl }),
    JSON.stringify({ greenfield: good })
  );

  it("returns a school's settings, and undefined for one with none", async () => {
    expect(await secrets.schoolAppEnv("greenfield")).toEqual(good);
    expect(await secrets.schoolAppEnv("nobody")).toBeUndefined();
  });

  it("works with no settings at all (a worker that never provisions)", async () => {
    expect(await new EnvSecrets(JSON.stringify({ a: dbUrl })).schoolAppEnv("a")).toBeUndefined();
  });

  it("redacts every setting's value from a message, as well as the database URL", () => {
    const text = `failed with ${good.SUPABASE_SERVICE_ROLE_KEY} and ${good.R2_SECRET_ACCESS_KEY} and ${dbUrl}`;
    const out = secrets.redact(text);
    expect(out).not.toContain(good.SUPABASE_SERVICE_ROLE_KEY);
    expect(out).not.toContain(good.R2_SECRET_ACCESS_KEY);
    expect(out).not.toContain("databasePassw0rd");
  });

  it("refuses settings that are not JSON of the right shape", () => {
    expect(() => new EnvSecrets(JSON.stringify({ a: dbUrl }), "nope")).toThrow(/SCHOOL_APP_ENVS/);
    expect(() => new EnvSecrets(JSON.stringify({ a: dbUrl }), '{"a":"flat"}')).toThrow(
      /SCHOOL_APP_ENVS/
    );
  });
});
