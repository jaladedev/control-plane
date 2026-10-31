import { describe, expect, it, vi } from "vitest";
import { commandLine, runDeployCommand, type DeployConfig, type Exec } from "@/lib/deploy/client";

const TAG = "a".repeat(40);
const ENV = "SCHOOL_SLUG=greenfield\nSUPABASE_SERVICE_ROLE_KEY=very-secret-value\n";
const base: DeployConfig = {
  host: "203.0.113.10",
  user: "root",
  keyFile: "/keys/deploy",
  knownHostsFile: "/keys/known_hosts",
};
const create = (
  over: Partial<Extract<Parameters<typeof commandLine>[0], { action: "create" }>> = {}
) => ({
  action: "create" as const,
  slug: "greenfield",
  tag: TAG,
  hostnames: ["green.example.com"],
  env: ENV,
  ...over,
});
const exec = (stdout: string, code: number | null = 0, stderr = "") =>
  vi.fn<Exec>(async () => ({ code, stdout, stderr, timedOut: false }));
const result = (action: string, status: string, tag = TAG) =>
  `RESULT {"slug":"greenfield","action":"${action}","status":"${status}","tag":"${tag}"}\n`;

describe("create and remove: the command line", () => {
  it("lists the slug, tag and hostnames, and nothing from the env file", () => {
    const line = commandLine(create({ hostnames: ["green.example.com", "www.green.example.com"] }));
    expect(line).toBe(`create greenfield ${TAG} green.example.com www.green.example.com`);
    expect(line).not.toContain("secret");
  });

  it("builds remove like rollback", () => {
    expect(commandLine({ action: "remove", slug: "greenfield" })).toBe("remove greenfield");
  });

  it.each([
    [[], /1 to 5/],
    [
      [
        "a.example.com",
        "b.example.com",
        "c.example.com",
        "d.example.com",
        "e.example.com",
        "f.example.com",
      ],
      /1 to 5/,
    ],
    [["Green.example.com"], /hostname/],
    [["green.example.com; id"], /hostname/],
    [["green"], /hostname/],
    [["-x.example.com"], /hostname/],
  ])("refuses the hostnames %j", (hostnames, message) => {
    expect(() => commandLine(create({ hostnames }))).toThrow(message);
  });

  it("refuses a bad tag or slug before anything is sent", () => {
    expect(() => commandLine(create({ tag: "abc" }))).toThrow(/Tag/);
    expect(() => commandLine(create({ slug: "Green; id" }))).toThrow(/slug/);
  });
});

describe("create: running it", () => {
  it("sends the env file on stdin, and only there", async () => {
    const run = exec(result("create", "ok"));
    const out = await runDeployCommand({ ...base, exec: run }, create());
    expect(out).toMatchObject({ ok: true, status: "ok", tag: TAG });
    const [args, , stdin] = run.mock.calls[0];
    expect(stdin).toBe(ENV);
    expect(args.join(" ")).not.toContain("very-secret-value");
    expect(args.at(-1)).toBe(`create greenfield ${TAG} green.example.com`);
  });

  it("sends no stdin for the other commands", async () => {
    const run = exec(result("status", "running"));
    await runDeployCommand({ ...base, exec: run }, { action: "status", slug: "greenfield" });
    expect(run.mock.calls[0][2]).toBeUndefined();
  });

  it("says the slug is taken for exit 3, rather than the deploy wording", async () => {
    const out = await runDeployCommand(
      { ...base, exec: exec(result("create", "exists", ""), 3) },
      create()
    );
    expect(out.ok).toBe(false);
    expect(out.message).toMatch(/already has a school/);
  });

  it.each([
    [13, /proxy/],
    [14, /removed/],
    [15, /could not be pulled/],
    [12, /Another operation/],
  ])("explains exit %i", async (code, message) => {
    const out = await runDeployCommand(
      { ...base, exec: exec(result("create", "failed", ""), code) },
      create()
    );
    expect(out).toMatchObject({ ok: false, code });
    expect(out.message).toMatch(message);
  });

  it("treats a remove that answered ok as done", async () => {
    const out = await runDeployCommand(
      { ...base, exec: exec(result("remove", "ok", "")) },
      { action: "remove", slug: "greenfield" }
    );
    expect(out.ok).toBe(true);
  });
});
