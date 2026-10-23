import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

// Runs deploy/school-deploy against a fake docker and curl (tests/fixtures/deploy)
// so the script's own logic is exercised: validation, state, health-gated swap,
// rollback, cleanup and locking. It does NOT prove the real docker flags work
// on the VPS; that needs the staging container (plan section 9).

const SCRIPT = resolve("deploy/school-deploy");
const FIX = resolve("tests/fixtures/deploy");
const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const ENV = "SCHOOL_SLUG=greenfield\nPAYSTACK_SECRET_KEY=sk_test_x\n";

let root: string;
const p = (...s: string[]) => join(root, ...s);

function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "",
    NODE_ENV: "test",
    SCHOOL_DEPLOY_CONF: "/nonexistent",
    FAKE_DIR: p("fake"),
    DOCKER: join(FIX, "docker"),
    CURL: join(FIX, "curl"),
    STATE_DIR: p("state"),
    ENV_DIR: p("env"),
    ROUTES_DIR: p("routes"),
    CADDY_RELOAD: `${join(FIX, "docker")} exec caddy reload`,
    HEALTH_TIMEOUT: "2",
    HEALTH_INTERVAL: "0.05",
    ...extra,
  };
}

function run(args: string[], input = "", extra: Record<string, string> = {}) {
  const r = spawnSync(SCRIPT, args, { env: env(extra), input, encoding: "utf8" });
  const last = r.stdout.trim().split("\n").pop() ?? "";
  return {
    code: r.status,
    out: r.stdout,
    err: r.stderr,
    result: last.startsWith("RESULT ") ? JSON.parse(last.slice(7)) : null,
  };
}

const list = (name: string, tags: string[]) =>
  writeFileSync(p("fake", name), tags.join("\n") + "\n");
const image = (slug = "greenfield") =>
  readFileSync(p("fake/containers", `school-${slug}`, "image"), "utf8").trim();
const calls = () =>
  existsSync(p("fake/calls.log")) ? readFileSync(p("fake/calls.log"), "utf8") : "";
const state = (f: string) => readFileSync(p("state/greenfield", f), "utf8").trim();

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "deploy-test-"));
  mkdirSync(p("fake"), { recursive: true });
});

const create = (tag = A) =>
  run(["create", "greenfield", tag, "greenfield.example.com", "school.example.org"], ENV);

describe("input checking", () => {
  it.each([
    [["deploy", "Bad_Slug", A]],
    [["deploy", "../etc", A]],
    [["deploy", "greenfield", "latest"]],
    [["deploy", "greenfield", A.slice(1)]],
    [["deploy", "greenfield", A, "extra"]],
    [["create", "greenfield", A]],
    [["create", "greenfield", A, "not a host"]],
    [["create", "greenfield", A, "bad_host.example.com"]],
    [["create", "greenfield", A, "Greenfield.example.com"]],
    [["destroy", "greenfield"]],
    [["deploy"]],
  ])("refuses %j before touching anything", (args) => {
    const r = run(args);
    expect(r.code).toBe(2);
    expect(r.result?.status).toBe("usage");
    expect(calls()).toBe("");
  });

  it("never echoes unvalidated words into the RESULT line", () => {
    const r = run(["deploy", 'x"},"y":"z', A]);
    expect(r.code).toBe(2);
    expect(r.result).toEqual({ slug: "", action: "", status: "usage", tag: "" });
  });

  it("reads the command from SSH_ORIGINAL_COMMAND, and a shell injection stays inert", () => {
    expect(run([], "", { SSH_ORIGINAL_COMMAND: "status greenfield" }).code).toBe(0);
    const evil = run([], "", {
      SSH_ORIGINAL_COMMAND: `deploy greenfield ${A}; touch ${p("pwned")}`,
    });
    expect(evil.code).toBe(2);
    const sub = run([], "", { SSH_ORIGINAL_COMMAND: `deploy greenfield $(touch ${p("pwned")})` });
    expect(sub.code).toBe(2);
    expect(existsSync(p("pwned"))).toBe(false);
  });
});

describe("create", () => {
  it("starts a limited container with no published ports, a private env file and a route", () => {
    const r = create();
    expect(r.code).toBe(0);
    expect(r.result).toEqual({ slug: "greenfield", action: "create", status: "ok", tag: A });
    const args = readFileSync(p("fake/containers/school-greenfield/args"), "utf8");
    expect(args).toContain("--restart\nunless-stopped");
    expect(args).toMatch(/--memory\n512m/);
    expect(args).toContain("--cap-drop\nALL");
    expect(args).not.toMatch(/^(-p|--publish)$/m);
    expect(image()).toBe(`ghcr.io/jaladedev/school_app:${A}`);
    expect((statSync(p("env/greenfield.env")).mode & 0o777).toString(8)).toBe("600");
    expect(readFileSync(p("env/greenfield.env"), "utf8")).toContain(
      "PAYSTACK_SECRET_KEY=sk_test_x"
    );
    expect(readFileSync(p("routes/greenfield.caddy"), "utf8")).toBe(
      "# managed by school-deploy; do not edit\ngreenfield.example.com, school.example.org {\n\treverse_proxy school-greenfield:3000\n}\n"
    );
    expect(state("current")).toBe(A);
  });

  it("does not leak secrets to the log or the call list", () => {
    create();
    expect(calls()).not.toContain("sk_test_x");
    expect(readFileSync(p("state/deploy.log"), "utf8")).not.toContain("sk_test_x");
  });

  it.each([
    ["no SCHOOL_SLUG", "PAYSTACK_SECRET_KEY=x\n"],
    ["another school's SCHOOL_SLUG", "SCHOOL_SLUG=other\n"],
    ["a bare key that would pass through the host's environment", "SCHOOL_SLUG=greenfield\nHOME\n"],
    ["IMAGE_TAG", "SCHOOL_SLUG=greenfield\nIMAGE_TAG=abc\n"],
    ["a lowercase or odd key", "SCHOOL_SLUG=greenfield\nfoo bar=1\n"],
  ])("refuses an env file with %s", (_why, body) => {
    const r = run(["create", "greenfield", A, "g.example.com"], body);
    expect(r.code).toBe(2);
    expect(existsSync(p("env/greenfield.env"))).toBe(false);
    expect(existsSync(p("fake/containers/school-greenfield"))).toBe(false);
  });

  it("refuses to create a school twice", () => {
    expect(create().code).toBe(0);
    expect(create(B).code).toBe(3);
    expect(image()).toContain(A);
  });

  it("removes everything if the new container never becomes healthy", () => {
    list("unhealthy", [A]);
    const r = create();
    expect(r.code).toBe(14);
    expect(r.result?.status).toBe("create_failed");
    for (const f of [
      "env/greenfield.env",
      "routes/greenfield.caddy",
      "state/greenfield",
      "fake/containers/school-greenfield",
    ]) {
      expect(existsSync(p(f))).toBe(false);
    }
  });

  it("removes everything if the image cannot be pulled", () => {
    list("pull-fail", [A]);
    expect(create().code).toBe(14);
    expect(existsSync(p("env/greenfield.env"))).toBe(false);
  });

  it("drops the route and reports it when the proxy will not load it", () => {
    writeFileSync(p("fake/caddy-fail"), "");
    const r = create();
    expect(r.code).toBe(13);
    expect(existsSync(p("routes/greenfield.caddy"))).toBe(false);
  });
});

describe("deploy", () => {
  beforeEach(() => void create(A));

  it("swaps to the new tag once it reports that version, and remembers the old one", () => {
    const r = run(["deploy", "greenfield", B]);
    expect(r.code).toBe(0);
    expect(r.result).toEqual({ slug: "greenfield", action: "deploy", status: "ok", tag: B });
    expect(image()).toContain(B);
    expect(state("current")).toBe(B);
    expect(state("previous")).toBe(A);
  });

  it("rolls back automatically when the new version is not healthy", () => {
    list("unhealthy", [B]);
    const r = run(["deploy", "greenfield", B]);
    expect(r.code).toBe(10);
    expect(r.result).toEqual({
      slug: "greenfield",
      action: "deploy",
      status: "rolled_back",
      tag: A,
    });
    expect(image()).toContain(A);
    expect(state("current")).toBe(A);
  });

  it("reports when the rollback fails too", () => {
    list("unhealthy", [A, B]);
    const r = run(["deploy", "greenfield", B]);
    expect(r.code).toBe(11);
    expect(r.result?.status).toBe("rollback_failed");
  });

  it("leaves the running container alone when the image cannot be pulled", () => {
    list("pull-fail", [B]);
    const before = calls();
    const r = run(["deploy", "greenfield", B]);
    expect(r.code).toBe(15);
    expect(calls().slice(before.length)).not.toContain("docker rm");
    expect(image()).toContain(A);
  });

  it("refuses to deploy a school that was never created", () => {
    expect(run(["deploy", "nowhere", B]).code).toBe(3);
  });
});

describe("rollback", () => {
  it("goes back to the previous tag, and swaps current and previous", () => {
    create(A);
    run(["deploy", "greenfield", B]);
    const r = run(["rollback", "greenfield"]);
    expect(r.code).toBe(0);
    expect(r.result?.tag).toBe(A);
    expect(image()).toContain(A);
    expect(state("current")).toBe(A);
    expect(state("previous")).toBe(B);
  });

  it("refuses when there is no previous version", () => {
    create(A);
    const r = run(["rollback", "greenfield"]);
    expect(r.code).toBe(3);
    expect(r.result?.status).toBe("no_previous");
  });

  it("puts the current version back if the previous one will not start", () => {
    create(A);
    run(["deploy", "greenfield", B]);
    list("unhealthy", [A]);
    const r = run(["rollback", "greenfield"]);
    expect(r.code).toBe(10);
    expect(image()).toContain(B);
    expect(state("current")).toBe(B);
  });
});

describe("remove and status", () => {
  it("removes the container, route, env file and state, and is safe to repeat", () => {
    create(A);
    expect(run(["remove", "greenfield"]).code).toBe(0);
    for (const f of [
      "env/greenfield.env",
      "routes/greenfield.caddy",
      "state/greenfield",
      "fake/containers/school-greenfield",
    ]) {
      expect(existsSync(p(f))).toBe(false);
    }
    expect(run(["remove", "greenfield"]).code).toBe(0);
  });

  it("reports the current and previous tag and whether it runs", () => {
    create(A);
    run(["deploy", "greenfield", B]);
    const r = run(["status", "greenfield"]);
    expect(r.out).toContain(`current=${B} previous=${A} running=true`);
    expect(r.result).toMatchObject({ status: "running", tag: B });
    expect(run(["status", "nowhere"]).result?.status).toBe("stopped");
  });
});

describe("locking", () => {
  it("refuses a second operation on the same school while one is running", async () => {
    create(A);
    mkdirSync(p("state/locks"), { recursive: true });
    const holder = spawn("bash", [
      "-c",
      `exec 9>${p("state/locks/greenfield.lock")}; flock 9; sleep 5`,
    ]);
    await new Promise((r) => setTimeout(r, 400));
    try {
      const r = run(["deploy", "greenfield", B]);
      expect(r.code).toBe(12);
      expect(r.result?.status).toBe("locked");
      expect(image()).toContain(A);
      // a different school is not blocked
      expect(run(["status", "other"]).code).toBe(0);
    } finally {
      holder.kill();
    }
  });
});

describe("unknown tag typo guard", () => {
  it("only accepts full commit hashes", () => {
    expect(run(["deploy", "greenfield", C.toUpperCase()]).code).toBe(2);
  });
});
