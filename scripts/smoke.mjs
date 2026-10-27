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
// React puts <!-- --> between adjacent text and values; remove it before matching text.
const flat = (html) => html.replace(/<!-- -->/g, "");
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
const state = { role: "owner", userOk: true, withSchool: false, withRelease: false, rollout: null };
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
  license_version: 2,
  license_pushed_version: 2,
  license_pushed_at: new Date().toISOString(),
  license_push_error: null,
  license_session: "2026/2027",
  features: [],
  license_is_trial: false,
  license_valid_until: null,
  license_grace_until: null,
  supabase_project_ref: "abcdefghijklmnopqrst",
  rollout_group: "test",
  schema_version: "20261001000000",
  credentials_status: "ok",
};
const RELEASES = [
  {
    id: "40000000-0000-4000-8000-000000000002",
    seq: 2,
    image_tag: "b".repeat(40),
    notes: "second",
    created_at: new Date().toISOString(),
  },
  {
    id: "40000000-0000-4000-8000-000000000001",
    seq: 1,
    image_tag: "a".repeat(40),
    notes: null,
    created_at: new Date().toISOString(),
  },
];
const MIGRATIONS = [
  {
    version: "20261002000000",
    name: "20261002000000_second",
    kind: "expand",
    release_id: RELEASES[0].id,
  },
  {
    version: "20261001000000",
    name: "20261001000000_first",
    kind: "expand",
    release_id: RELEASES[1].id,
  },
];
const ROLLOUT_ID = "50000000-0000-4000-8000-000000000001";
const rolloutRow = (status) => ({
  id: ROLLOUT_ID,
  release_id: RELEASES[0].id,
  image_tag: "b".repeat(40),
  status,
  batch_size: 5,
  released_through: 2,
  halt_reason: status === "halted" ? "A step failed: The new version was not healthy" : null,
  created_by: "owner@example.com",
  created_at: new Date().toISOString(),
  finished_at: null,
});
const stepRows = (halted) => [
  {
    id: "60000000-0000-4000-8000-000000000001",
    position: 1,
    stage: "test",
    batch_no: 0,
    status: "succeeded",
    attempt: 1,
    error: null,
    result: {
      applied: ["20261002000000_second"],
      from_tag: "a".repeat(40),
      to_tag: "b".repeat(40),
    },
    finished_at: new Date().toISOString(),
    schools: { slug: "greenfield", name: "Greenfield School" },
  },
  {
    id: "60000000-0000-4000-8000-000000000002",
    position: 2,
    stage: "pilot",
    batch_no: 0,
    status: halted ? "failed" : "running",
    attempt: 1,
    error: halted
      ? "Deploy failed: The new version was not healthy; the server rolled back to the old one."
      : null,
    result: null,
    finished_at: null,
    schools: { slug: "bluefield", name: "Bluefield Academy" },
  },
  {
    id: "60000000-0000-4000-8000-000000000003",
    position: 3,
    stage: "batch",
    batch_no: 1,
    status: "pending",
    attempt: 1,
    error: null,
    result: null,
    finished_at: null,
    schools: { slug: "redfield", name: "Redfield College" },
  },
];
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
    } else if (url.startsWith("/rest/v1/releases") && state.withRelease) {
      res.end(JSON.stringify(RELEASES));
    } else if (url.startsWith("/rest/v1/migrations") && state.withRelease) {
      res.end(JSON.stringify(MIGRATIONS));
    } else if (url.startsWith("/rest/v1/rollout_steps") && state.rollout) {
      res.end(JSON.stringify(stepRows(state.rollout === "halted")));
    } else if (url.startsWith("/rest/v1/rollouts") && state.rollout && url.includes("status=in.")) {
      res.end(JSON.stringify([rolloutRow(state.rollout)]));
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
    for (const p of [
      "/",
      "/users",
      "/audit",
      "/mfa",
      "/schools/new",
      `/schools/${SCHOOL_ID}`,
      "/migrations",
      "/billing",
      "/billing/new",
      "/prices",
    ]) {
      const res = await get(p);
      check(
        `signed out: ${p} goes to /login`,
        redirectsTo(res, "/login"),
        `${res.status} ${res.headers.get("location")}`
      );
    }
    check("signed out: /login opens", (await get("/login")).status === 200);
    const claim = await fetch(`${base}/api/claims`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const claimBody = await claim.json().catch(() => null);
    check(
      "signed out: POST /api/claims is reachable but rejects an unsigned request without a redirect",
      claim.status === 401 && claimBody?.ok === false && claimBody?.error === "Request rejected.",
      `${claim.status} ${JSON.stringify(claimBody)}`
    );

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
    check(
      "owner: licence form and revoke control are shown",
      detailHtml.includes("Save and push new version") && detailHtml.includes("Revoke licence")
    );
    state.withSchool = false;
    // Migrations screen: owner
    const mig = await get("/migrations", aal2);
    const migHtml = await mig.text();
    check("owner: /migrations opens", mig.status === 200, `${mig.status}`);
    const ownerMig = flat(migHtml);
    check(
      "owner: sees Register a release, Roll out to one school and Roll a school back",
      ownerMig.includes("Register a release") &&
        ownerMig.includes("Roll out to one school") &&
        ownerMig.includes("Roll a school back"),
      JSON.stringify({
        register: ownerMig.includes("Register a release"),
        one: ownerMig.includes("Roll out to one school"),
        back: ownerMig.includes("Roll a school back"),
      })
    );
    check("owner: nav links to Migrations", homeHtml.includes('href="/migrations"'));
    check(
      "owner: nav links to Billing and Prices",
      homeHtml.includes('href="/billing"') && homeHtml.includes('href="/prices"')
    );
    const bill = await get("/billing", aal2);
    const billHtml = flat(await bill.text());
    check(
      "owner: /billing opens with the claims queue and invoices",
      bill.status === 200 &&
        billHtml.includes("Claims waiting") &&
        billHtml.includes("New invoice"),
      `${bill.status}`
    );
    const prices = await get("/prices", aal2);
    const pricesHtml = flat(await prices.text());
    check(
      "owner: /prices opens and can set a price and an override",
      prices.status === 200 &&
        pricesHtml.includes("Set a price") &&
        pricesHtml.includes("Give one school a different price"),
      `${prices.status}`
    );
    const newInvoice = await get("/billing/new", aal2);
    check("owner: /billing/new opens", newInvoice.status === 200, `${newInvoice.status}`);
    state.withSchool = true;
    const sch = await get(`/schools/${SCHOOL_ID}`, aal2);
    const schHtml = flat(await sch.text());
    state.withSchool = false;
    check(
      "owner: a school page offers claim keys",
      sch.status === 200 && schHtml.includes("Payment claim keys"),
      `${sch.status}`
    );
    check(
      "owner: with no release, the screen says how to register one",
      migHtml.includes("No release is registered")
    );

    state.withRelease = true;
    state.withSchool = true;
    const start = flat(await (await get("/migrations", aal2)).text());
    check(
      "owner: with a release, the start form and plan preview are shown",
      start.includes("Plan rollout") && start.includes("Would include 1 test"),
      start.slice(0, 120)
    );
    check(
      "owner: the version matrix shows the school's database and pending count",
      start.includes("Greenfield School") &&
        start.includes("20261001000000") &&
        start.includes("1 pending")
    );
    check("owner: Refresh versions is offered", start.includes("Refresh versions"));

    state.rollout = "running";
    const running = flat(await (await get("/migrations", aal2)).text());
    check(
      "owner: a running rollout shows its steps and results",
      running.includes("Rollout of") &&
        running.includes("Bluefield Academy") &&
        running.includes("1 applied") &&
        running.includes("1 of 3 schools done"),
      running.slice(0, 120)
    );
    check(
      "owner: while a school runs, releases are blocked and the screen says why",
      running.includes("Waiting for the released schools to finish") &&
        running.includes("Cancel rollout") &&
        running.includes("Updating live")
    );
    check(
      "owner: the start form is replaced while a rollout is active",
      !running.includes("Plan rollout")
    );

    state.rollout = "halted";
    const halted = flat(await (await get("/migrations", aal2)).text());
    check(
      "owner: a halted rollout shows the failure, offers a retry, and stops refreshing",
      halted.includes("Stopped on a failure") &&
        halted.includes("rolled back to the old one") &&
        halted.includes("Retry") &&
        !halted.includes("Updating live"),
      halted.slice(0, 120)
    );
    state.rollout = null;
    state.withRelease = false;
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
        `${role}: licence form is ${role === "finance" ? "shown (no revoke)" : "hidden"}`,
        role === "finance"
          ? dhHtml.includes("Save and push new version") && !dhHtml.includes("Revoke licence")
          : !dhHtml.includes("Save and push new version")
      );
      check(
        `${role}: school page opens read-only`,
        dh.status === 200 &&
          dhHtml.includes("Greenfield School") &&
          !dhHtml.includes("Save changes"),
        `${dh.status}`
      );
      state.withSchool = false;
      state.withRelease = true;
      state.withSchool = true;
      state.rollout = "running";
      const mh = await get("/migrations", aal2);
      const mhHtml = flat(await mh.text());
      check(
        `${role}: /migrations opens read-only (rollout visible, no controls)`,
        mh.status === 200 &&
          mhHtml.includes("Rollout of") &&
          !mhHtml.includes("Cancel rollout") &&
          !mhHtml.includes("Release test school") &&
          !mhHtml.includes("Refresh versions") &&
          !mhHtml.includes("Register a release") &&
          !mhHtml.includes("Roll out to one school") &&
          !mhHtml.includes("Roll a school back"),
        JSON.stringify({
          status: mh.status,
          rollout: mhHtml.includes("Rollout of"),
          cancel: mhHtml.includes("Cancel rollout"),
          release: mhHtml.includes("Release test school"),
          refresh: mhHtml.includes("Refresh versions"),
        })
      );
      state.rollout = null;
      const mi = flat(await (await get("/migrations", aal2)).text());
      check(
        `${role}: cannot start a rollout`,
        !mi.includes("Plan rollout") && mi.includes("Only an owner can start a rollout")
      );
      state.withRelease = false;
      state.withSchool = false;
      if (role === "finance") {
        const fb = await get("/billing", aal2);
        const fbHtml = flat(await fb.text());
        check(
          "finance: /billing opens",
          fb.status === 200 &&
            fbHtml.includes("Claims waiting") &&
            fbHtml.includes('href="/billing"'),
          `${fb.status}`
        );
        const fp = flat(await (await get("/prices", aal2)).text());
        check(
          "finance: /prices is read-only (no price or override forms)",
          fp.includes("In force now") &&
            !fp.includes("Set a price") &&
            !fp.includes("Give one school a different price")
        );
        state.withSchool = true;
        const fsRes = await get(`/schools/${SCHOOL_ID}`, aal2);
        const fs = flat(await fsRes.text());
        state.withSchool = false;
        check(
          "finance: a school page opens but hides claim keys",
          fsRes.status === 200 && fs.includes("Health") && !fs.includes("Payment claim keys"),
          `${fsRes.status}`
        );
      } else {
        for (const p of ["/billing", "/billing/new", "/prices"]) {
          const res = await get(p, aal2);
          check(
            `${role}: ${p} sends them home`,
            redirectsTo(res, "/"),
            `${res.status} ${res.headers.get("location")}`
          );
        }
        const home = flat(await (await get("/", aal2)).text());
        check(
          `${role}: nav has no Billing or Prices`,
          !home.includes('href="/billing"') && !home.includes('href="/prices"')
        );
      }
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
