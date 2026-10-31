import { describe, expect, it, vi } from "vitest";
import {
  buildSshArgs,
  commandLine,
  runDeployCommand,
  type DeployConfig,
  type Exec,
} from "@/lib/deploy/client";

const TAG = "a".repeat(40);
const base = {
  host: "203.0.113.10",
  user: "root",
  keyFile: "/keys/deploy",
  knownHostsFile: "/keys/known_hosts",
};
const cfg = (exec: Exec, extra: Partial<DeployConfig> = {}): DeployConfig => ({
  ...base,
  exec,
  ...extra,
});
const ok = (stdout: string, code: number | null = 0, stderr = "") =>
  vi.fn<Exec>(async () => ({ code, stdout, stderr, timedOut: false }));
const result = (status: string, tag = TAG) =>
  `pulling...\nRESULT {"slug":"greenfield","action":"deploy","status":"${status}","tag":"${tag}"}\n`;

describe("commandLine", () => {
  it("builds the three commands the script accepts", () => {
    expect(commandLine({ action: "deploy", slug: "greenfield", tag: TAG })).toBe(
      `deploy greenfield ${TAG}`
    );
    expect(commandLine({ action: "rollback", slug: "greenfield" })).toBe("rollback greenfield");
    expect(commandLine({ action: "status", slug: "greenfield" })).toBe("status greenfield");
  });

  it.each(["a; rm -rf /", "Green", "a b", "../x", "", "-flag-", "a$(id)b", "x".repeat(41), "ab"])(
    "refuses the slug %j",
    (slug) => {
      expect(() => commandLine({ action: "rollback", slug })).toThrow(/slug/);
    }
  );

  it.each(["abc", "A".repeat(40), `${"a".repeat(39)};`, "a".repeat(41), "", `${"a".repeat(39)} `])(
    "refuses the tag %j",
    (tag) => {
      expect(() => commandLine({ action: "deploy", slug: "greenfield", tag })).toThrow(/Tag/);
    }
  );

  it("refuses an unknown action", () => {
    expect(() => commandLine({ action: "restart", slug: "greenfield" } as never)).toThrow(
      /Unknown/
    );
  });
});

describe("buildSshArgs", () => {
  it("pins the key, refuses to prompt, and verifies the host key", () => {
    const args = buildSshArgs(base as DeployConfig, "status greenfield");
    expect(args).toEqual([
      "-i",
      "/keys/deploy",
      "-o",
      "BatchMode=yes",
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      "UserKnownHostsFile=/keys/known_hosts",
      "-o",
      "ConnectTimeout=15",
      "-o",
      "ServerAliveInterval=15",
      "root@203.0.113.10",
      "status greenfield",
    ]);
  });

  it.each([
    ["host", { host: "-oProxyCommand=evil" }],
    ["host", { host: "a b" }],
    ["user", { user: "-oProxyCommand=evil" }],
    ["user", { user: "root;id" }],
    ["host", { host: "" }],
  ])("refuses a %s that could be read as an ssh option: %j", (_n, patch) => {
    expect(() => buildSshArgs({ ...base, ...patch } as DeployConfig, "x")).toThrow(/looks wrong/);
  });
});

describe("runDeployCommand", () => {
  it("is ok on exit 0 with an ok RESULT, and sends the command as the last argument", async () => {
    const exec = ok(result("ok"));
    const out = await runDeployCommand(cfg(exec), {
      action: "deploy",
      slug: "greenfield",
      tag: TAG,
    });
    expect(out).toEqual({ ok: true, code: 0, status: "ok", tag: TAG, message: "" });
    expect(exec.mock.calls[0][0].at(-1)).toBe(`deploy greenfield ${TAG}`);
  });

  it("accepts running and stopped for status", async () => {
    for (const status of ["running", "stopped"]) {
      const out = await runDeployCommand(cfg(ok(result(status))), {
        action: "status",
        slug: "greenfield",
      });
      expect(out.ok).toBe(true);
    }
  });

  it.each([
    [10, /rolled back to the old one/],
    [11, /rollback failed.*Look at the server/],
    [12, /already running/],
    [13, /proxy/],
    [15, /could not be pulled/],
    [3, /unknown to the server/],
    [2, /refused the command/],
  ])("explains exit code %i", async (code, message) => {
    const out = await runDeployCommand(cfg(ok(result("rolled_back"), code)), {
      action: "deploy",
      slug: "greenfield",
      tag: TAG,
    });
    expect(out.ok).toBe(false);
    expect(out.code).toBe(code);
    expect(out.message).toMatch(message);
  });

  it("treats ssh's 255 as a connection failure", async () => {
    const out = await runDeployCommand(cfg(ok("", 255, "ssh: connect to host failed")), {
      action: "status",
      slug: "greenfield",
    });
    expect(out).toMatchObject({ ok: false, code: 255 });
    expect(out.message).toMatch(/Could not connect/);
  });

  it("is not ok when exit 0 comes without a RESULT line", async () => {
    const out = await runDeployCommand(cfg(ok("all done, trust me")), {
      action: "deploy",
      slug: "greenfield",
      tag: TAG,
    });
    expect(out.ok).toBe(false);
  });

  it("is not ok when exit 0 reports a non-ok status", async () => {
    const out = await runDeployCommand(cfg(ok(result("rolled_back"))), {
      action: "deploy",
      slug: "greenfield",
      tag: TAG,
    });
    expect(out.ok).toBe(false);
  });

  it("is not ok when the RESULT line is not JSON", async () => {
    const out = await runDeployCommand(cfg(ok("RESULT {oops")), {
      action: "deploy",
      slug: "greenfield",
      tag: TAG,
    });
    expect(out.ok).toBe(false);
  });

  it("reports a timeout and tells the operator to check the server", async () => {
    const exec = vi.fn<Exec>(async () => ({ code: null, stdout: "", stderr: "", timedOut: true }));
    const out = await runDeployCommand(cfg(exec, { timeoutMs: 5 }), {
      action: "deploy",
      slug: "greenfield",
      tag: TAG,
    });
    expect(out).toMatchObject({ ok: false, status: "timeout" });
    expect(out.message).toMatch(/Check the server/);
    expect(exec.mock.calls[0][1]).toBe(5);
  });

  it("includes the script's last error line for an unexpected exit code", async () => {
    const out = await runDeployCommand(cfg(ok("", 99, "boom\nsomething odd happened")), {
      action: "status",
      slug: "greenfield",
    });
    expect(out.message).toMatch(/code 99.*something odd happened/);
  });

  it("never reaches ssh with bad input", async () => {
    const exec = ok(result("ok"));
    await expect(
      runDeployCommand(cfg(exec), { action: "deploy", slug: "x; reboot", tag: TAG })
    ).rejects.toThrow();
    await expect(
      runDeployCommand(cfg(exec), { action: "deploy", slug: "greenfield", tag: "short" })
    ).rejects.toThrow();
    expect(exec).not.toHaveBeenCalled();
  });
});
