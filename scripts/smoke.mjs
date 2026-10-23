#!/usr/bin/env node
/**
 * Smoke test of the built app (run `npm run build` first). Starts `next start`
 * against a mock Supabase and checks the front door: who is sent where, which
 * pages each role can open, and that the 2FA level is read from the session.
 *
 *   node scripts/smoke.mjs
 */
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const results = [];
const CRON_SECRET = "c".repeat(40);
function check(name, ok, detail = "") {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n      ${detail}`}`);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// A stand-in for the control plane's Supabase. `state.role` is what
// dashboard_role() returns (null means "not an active dashboard user").
const state = { role: "owner", userOk: true, withSchool: false };
const SCHOOL_ID = "30000000-0000-4000-8000-000000000001";
const SCHOOL = {
  id: SCHOOL_ID,
  slug: "greenfield",
  name: "Greenfield School",
  status: "active",
  hostnames: ["green.example.com"],
  hosting_plan: "pro",
  included_students: 300,
  image_tag: "abc1234",
  health_status: "up",
  last_checked_at: new Date().toISOString(),
  last_ok_at: new Date().toISOString(),
  last_error: null,
  license_version: 0,
  license_is_trial: false,
  license_valid_until: null,
  license_grace_until: null,
};
async function startMock() {
  const port = await freePort();
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    const url = req.url ?? "";
    if (url.startsWith("/auth/v1/user")) {
      if (!state.userOk) {
        res.statusCode = 401;
        res.end(JSON.stringify({ code: 401, msg: "invalid JWT" }));
      } else {
        res.end(
          JSON.stringify({
            id: "00000000-0000-4000-8000-00000000000a",
            aud: "authenticated",
            role: "authenticated",
            email: "me@example.com",
            app_metadata: {},
            user_metadata: {},
            created_at: "2026-10-22T00:00:00Z",
          })
        );
      }
    } else if (url.startsWith("/auth/v1/logout")) {
      res.statusCode = 204;
      res.end();
    } else if (url.startsWith("/rest/v1/rpc/dashboard_role")) {
      res.end(JSON.stringify(state.role));
    } else if (url.startsWith("/rest/v1/schools") && state.withSchool) {
      res.end(JSON.stringify([SCHOOL]));
    } else if (url.startsWith("/rest/v1/")) {
      res.end("[]");
    } else {
      res.statusCode = 404;
      res.end("{}");
    }
  });
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  return { port, close: () => new Promise((r) => server.close(r)) };
}

// A session cookie like @supabase/ssr writes. The access token is unsigned:
// the app decodes its "aal" claim (the server verifies the user separately).
function sessionCookie(mockPort, aal) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const jwt = `${b64({ alg: "none", typ: "JWT" })}.${b64({ sub: "00000000-0000-4000-8000-00000000000a", aal, exp, role: "authenticated", session_id: "s1" })}.sig`;
  const session = {
    access_token: jwt,
    refresh_token: "refresh",
    token_type: "bearer",
    expires_in: 3600,
    expires_at: exp,
    user: {
      id: "00000000-0000-4000-8000-00000000000a",
      aud: "authenticated",
      email: "me@example.com",
      app_metadata: {},
      user_metadata: {},
    },
  };
  return `sb-127-auth-token=base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`;
}

async function main() {
  const mock = await startMock();
  const port = await freePort();
  const app = spawn(
    path.join(ROOT, "node_modules/.bin/next"),
    ["start", "-p", String(port), "-H", "127.0.0.1"],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        SUPABASE_URL: `http://127.0.0.1:${mock.port}`,
        SUPABASE_ANON_KEY: "anon",
        SUPABASE_SERVICE_ROLE_KEY: "service",
        CRON_SECRET: CRON_SECRET,
        NEXT_TELEMETRY_DISABLED: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  let log = "";
  app.stdout.on("data", (d) => (log += d));
  app.stderr.on("data", (d) => (log += d));

  const base = `http://127.0.0.1:${port}`;
  const get = (p, cookie) =>
    fetch(base + p, { redirect: "manual", headers: cookie ? { cookie } : {} });
  const loc = (res) =>
    new URL(res.headers.get("location") ?? "", base).pathname +
    new URL(res.headers.get("location") ?? "", base).search;
  const redirectsTo = (res, to) => res.status >= 300 && res.status < 400 && loc(res) === to;

  try {
    for (let i = 0; i < 120; i++) {
      try {
        await fetch(`${base}/api/health`);
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    const aal1 = sessionCookie(mock.port, "aal1");
    const aal2 = sessionCookie(mock.port, "aal2");

    // Signed out
    check("health probe works without signing in", (await get("/api/health")).status === 200);

    // The scheduler's route: reachable without a session, guarded by its secret
    const cron = (authorization) =>
      fetch(`${base}/api/cron/health`, {
        method: "POST",
        redirect: "manual",
        headers: authorization ? { authorization } : {},
      });
    for (const header of [undefined, "Bearer wrong", CRON_SECRET]) {
      const res = await cron(header);
      check(
        `cron route refuses ${header === undefined ? "no header" : header === CRON_SECRET ? "a bare secret" : "a wrong secret"}`,
        res.status === 401,
        `${res.status}`
      );
    }
    const cronOk = await cron(`Bearer ${CRON_SECRET}`);
    const cronBody = await cronOk.json().catch(() => ({}));
    check(
      "cron route runs with the right secret (no schools: nothing checked)",
      cronOk.status === 200 && cronBody.ok === true && cronBody.checked === 0,
      `${cronOk.status} ${JSON.stringify(cronBody)}`
    );
    check("cron route is POST only", (await get("/api/cron/health")).status === 405);
    for (const p of ["/", "/users", "/audit", "/mfa", "/schools/new", `/schools/${SCHOOL_ID}`]) {
      const res = await get(p);
      check(
        `signed out: ${p} goes to /login`,
        redirectsTo(res, "/login"),
        `${res.status} ${res.headers.get("location")}`
      );
    }
    check("signed out: /login opens", (await get("/login")).status === 200);

    // Password only (aal1)
    state.userOk = true;
    for (const p of ["/", "/users", "/audit", "/login"]) {
      const res = await get(p, aal1);
      check(
        `password only: ${p} goes to /mfa`,
        redirectsTo(res, "/mfa"),
        `${res.status} ${res.headers.get("location")}`
      );
    }

    // Session the server does not accept (token rejected)
    state.userOk = false;
    const rejected = await get("/", aal2);
    check(
      "a session the server rejects is treated as signed out",
      redirectsTo(rejected, "/login"),
      `${rejected.status} ${rejected.headers.get("location")}`
    );
    state.userOk = true;

    // 2FA done, but not an active dashboard user
    state.role = null;
    const noAccess = await get("/", aal2);
    check(
      "2FA but no dashboard role: signed out with a message",
      redirectsTo(noAccess, "/login?error=no-access"),
      `${noAccess.status} ${noAccess.headers.get("location")}`
    );
    check(
      "...and the session cookies are cleared",
      (noAccess.headers.getSetCookie?.() ?? []).some(
        (c) => c.startsWith("sb-127-auth-token=") && /max-age=0|expires=/i.test(c)
      )
    );

    // Owner
    state.role = "owner";
    const home = await get("/", aal2);
    const homeHtml = await home.text();
    check(
      "owner: schools page opens and shows the empty state",
      home.status === 200 && homeHtml.includes("No schools yet"),
      `${home.status}`
    );
    check(
      "owner: nav shows Users and Audit log",
      homeHtml.includes("Users") && homeHtml.includes("Audit log")
    );
    check("owner: Add school link is shown", homeHtml.includes('href="/schools/new"'));
    check("owner: /schools/new opens", (await get("/schools/new", aal2)).status === 200);
    check(
      "owner: an unknown school is a 404",
      (await get(`/schools/${SCHOOL_ID}`, aal2)).status === 404
    );
    state.withSchool = true;
    const listed = await (await get("/", aal2)).text();
    check(
      "owner: a registered school is listed with its health and version",
      listed.includes("Greenfield School") && listed.includes(">up<") && listed.includes("abc1234"),
      listed.slice(0, 200)
    );
    const detail = await get(`/schools/${SCHOOL_ID}`, aal2);
    const detailHtml = await detail.text();
    check(
      "owner: school page opens with the edit form and status control",
      detail.status === 200 &&
        detailHtml.includes("Save changes") &&
        detailHtml.includes("Recent health checks"),
      `${detail.status}`
    );
    state.withSchool = false;
    check("owner: /users opens", (await get("/users", aal2)).status === 200);
    check("owner: /audit opens", (await get("/audit", aal2)).status === 200);
    check(
      "owner: /login and /mfa send them home",
      redirectsTo(await get("/login", aal2), "/") && redirectsTo(await get("/mfa", aal2), "/")
    );

    // Finance and support
    for (const role of ["finance", "support"]) {
      state.role = role;
      const h = await get("/", aal2);
      const html = await h.text();
      check(`${role}: schools page opens`, h.status === 200);
      check(
        `${role}: nav hides Users and Audit log`,
        !html.includes('href="/users"') && !html.includes('href="/audit"')
      );
      check(`${role}: no Add school link`, !html.includes('href="/schools/new"'));
      state.withSchool = true;
      const dh = await get(`/schools/${SCHOOL_ID}`, aal2);
      const dhHtml = await dh.text();
      check(
        `${role}: school page opens read-only`,
        dh.status === 200 &&
          dhHtml.includes("Greenfield School") &&
          !dhHtml.includes("Save changes"),
        `${dh.status}`
      );
      state.withSchool = false;
      for (const p of ["/users", "/audit", "/schools/new"]) {
        const res = await get(p, aal2);
        check(
          `${role}: ${p} sends them home`,
          redirectsTo(res, "/"),
          `${res.status} ${res.headers.get("location")}`
        );
      }
    }

    // Security headers
    const headers = (await get("/login")).headers;
    check(
      "pages are not cacheable or frameable",
      headers.get("cache-control") === "no-store" && headers.get("x-frame-options") === "DENY"
    );
  } catch (error) {
    check(
      "smoke test ran to completion",
      false,
      error instanceof Error ? error.message : String(error)
    );
  } finally {
    if (results.includes(false)) console.log(`\n--- app log ---\n${log.slice(-3000)}`);
    app.kill("SIGTERM");
    await mock.close();
  }
  const failed = results.filter((ok) => !ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}

main();
