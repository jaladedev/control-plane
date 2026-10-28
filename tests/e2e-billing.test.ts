import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";
import { generateClaimKeyPair, signClaim } from "@/lib/billing/claim-signature";
import { handleClaim } from "@/lib/billing/claim-endpoint";
import type { SchoolAuthDeps } from "@/lib/billing/school-request";
import { handleCheckout } from "@/lib/paystack/checkout";
import { paystackSignature } from "@/lib/paystack/signature";
import { handlePaystackWebhook } from "@/lib/paystack/webhook";
import { buildQuote, type OverrideRow, type PriceRow } from "@/lib/billing/quote";
import type { DeployOutcome } from "@/lib/deploy/client";
import { EnvSecrets } from "@/worker/secrets";
import { SupabaseStore } from "@/worker/store";
import { tick, type WorkerDeps } from "@/worker/run";
import { pgSupabase } from "@/tests/helpers/pg-supabase";
import { fakeBackup } from "@/tests/helpers/fake-backup";

// The money path end to end on real Postgres: prices, a quote, an invoice, a signed
// claim through the real endpoint logic, the Telegram notice, a person confirming
// it, and the licence arriving in the school's own database. Telegram is a stub;
// the school's set_license is a stand-in with the same signature and the same
// "ignore a version you already have" rule. Set RUNNER_TEST_PG to run these.
const ADMIN_URL = process.env.RUNNER_TEST_PG;
const dbUrl = (name: string) => ADMIN_URL!.replace(/\/[^/]*$/, `/${name}`);

const STAND_IN_SCHOOL_DB = `
  create table school_license (school_id uuid primary key, version bigint not null, session text,
    valid_until timestamptz, grace_until timestamptz, student_cap integer, features text[], is_trial boolean);
  create function set_license(p_school_id uuid, p_version bigint, p_session text, p_valid_until timestamptz,
    p_grace_until timestamptz, p_student_cap integer, p_features text[], p_is_trial boolean)
  returns boolean language plpgsql as $$
  declare n integer;
  begin
    insert into school_license values (p_school_id, p_version, p_session, p_valid_until, p_grace_until, p_student_cap, p_features, p_is_trial)
    on conflict (school_id) do update set version = p_version, session = p_session, valid_until = p_valid_until,
      grace_until = p_grace_until, student_cap = p_student_cap, features = p_features, is_trial = p_is_trial
      where school_license.version < p_version;
    get diagnostics n = row_count;
    return n > 0;
  end $$;`;

describe.skipIf(!ADMIN_URL)(
  "billing end to end (real SQL, store, worker and school database)",
  () => {
    let admin: Client;
    let cp: Client;
    let school: Client;
    const created: string[] = [];
    let rpc: ReturnType<typeof pgSupabase>["rpc"];
    let deps: WorkerDeps;
    let sent: string[];
    let connectFails: number;
    let telegramOn: boolean;
    let keys: { privateKey: string; publicKey: string };
    let schoolId: string;

    const q = async (c: Client, sql: string, params: unknown[] = []) =>
      (await c.query(sql, params)).rows;
    const one = async (sql: string, params: unknown[] = []) => (await q(cp, sql, params))[0];
    const newDb = async (prefix: string) => {
      const name = `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
      await admin.query(`create database ${name}`);
      created.push(name);
      const c = new Client({ connectionString: dbUrl(name) });
      await c.connect();
      return c;
    };
    const call = async (name: string, args: Record<string, unknown>) => {
      const res = await rpc(name, args);
      if (res.error) throw new Error(res.error.message);
      return res.data;
    };
    const drain = async () => {
      let n = 0;
      while (await tick(deps)) n++;
      return n;
    };
    const jobs = (type: string) =>
      q(
        cp,
        "select status, attempts, error, result from jobs where type = $1 order by created_at",
        [type]
      );
    const sub = async (id: string) => one("select * from subscriptions where id = $1", [id]);
    const licenseRow = async () =>
      one("select school_id from schools limit 1").then(() =>
        q(school, "select * from school_license")
      );

    // The dashboard's own quote engine, fed from the real catalog rows.
    const quote = async (extra = 20, features = ["sms_alerts"]) => {
      const prices = (
        await q(
          cp,
          "select item, amount_kobo, count, effective_from, created_at from price_catalog"
        )
      ).map((r) => ({
        item: r.item,
        amount_kobo: r.amount_kobo === null ? null : Number(r.amount_kobo),
        count: r.count,
        effective_from: new Date(r.effective_from).toISOString(),
        created_at: new Date(r.created_at).toISOString(),
      })) as PriceRow[];
      return buildQuote({
        session: "2026/2027",
        asOf: new Date(),
        prices,
        overrides: [] as OverrideRow[],
        schoolIncludedStudents: 0,
        extraStudents: extra,
        features,
        proHosting: false,
      });
    };
    const invoice = async (extra = 20) => {
      const qt = await quote(extra);
      const id = (await call("create_subscription", {
        p_school: schoolId,
        p_session: qt.session,
        p_included: qt.included_students,
        p_extra: qt.extra_students,
        p_amount: qt.total_kobo,
        p_valid_until: new Date(Date.now() + 300 * 86_400_000).toISOString(),
        p_grace_until: new Date(Date.now() + 314 * 86_400_000).toISOString(),
        p_items: JSON.stringify(
          qt.lines
            .filter((l) => l.item.startsWith("feature:"))
            .map((l) => ({ feature: l.item.slice(8), amount_kobo: l.total_kobo }))
        ),
        p_quote: JSON.stringify(qt),
        p_by: "finance@example.com",
      })) as string;
      return { id, qt, row: await sub(id) };
    };

    // The lookups every signed school request makes, against this database.
    const authDeps: SchoolAuthDeps = {
      findSchool: async (slug) =>
        (await q(cp, "select id, status from schools where slug = $1", [slug]))[0] ?? null,
      publicKeys: async (id) =>
        (
          await q(
            cp,
            "select public_key from school_signing_keys where school_id = $1 and revoked_at is null",
            [id]
          )
        ).map((r) => r.public_key),
      rateLimit: async (bucket, windowSeconds, max) => {
        const r = await rpc("rate_limit_hit", {
          p_bucket: bucket,
          p_window_seconds: windowSeconds,
          p_max: max,
        });
        if (r.error) throw new Error(r.error.message);
        return r.data === true;
      },
    };

    // A school posting a claim: the real endpoint logic, wired to this database.
    const post = async (
      body: Record<string, unknown>,
      opts: { key?: string; at?: number } = {}
    ) => {
      const raw = JSON.stringify(body);
      const ts = opts.at ?? Math.floor(Date.now() / 1000);
      return handleClaim(
        {
          slug: "alpha",
          timestamp: String(ts),
          signature: signClaim({
            privateKey: opts.key ?? keys.privateKey,
            slug: "alpha",
            timestamp: ts,
            body: raw,
          }),
          rawBody: raw,
          ip: "203.0.113.7",
        },
        {
          ...authDeps,
          audit: async (action, id, details) =>
            void (await cp.query(
              "insert into audit_log (actor_email, role, action, school_id, details) values ('school:alpha','school',$1,$2,$3)",
              [action, id, details]
            )),
          submit: async (id, b) => {
            const r = await rpc("submit_claim", {
              p_school: id,
              p_reference: b.subscription_reference,
              p_client_ref: b.client_ref,
              p_amount_kobo: b.amount_kobo,
              p_sent_on: b.sent_on,
              p_sender: b.sender_name,
              p_payer_reference: b.payer_reference ?? null,
              p_proof_path: b.proof_path ?? null,
              p_claimed_by: b.claimed_by,
            });
            return r.error ? { businessError: r.error.message } : { claimId: r.data as string };
          },
        }
      );
    };
    const claimBody = (reference: string, amount: number, over: Record<string, unknown> = {}) => ({
      subscription_reference: reference,
      client_ref: "claim-0001",
      amount_kobo: amount,
      sent_on: new Date().toISOString().slice(0, 10),
      sender_name: "A. Bursar",
      claimed_by: "bursar@alpha.example",
      ...over,
    });

    beforeAll(async () => {
      admin = new Client({ connectionString: ADMIN_URL });
      await admin.connect();
    });
    afterAll(async () => {
      await cp?.end().catch(() => {});
      await school?.end().catch(() => {});
      await Promise.all(
        created.map((n) => admin.query(`drop database if exists ${n} with (force)`))
      );
      await admin.end();
    }, 120_000);

    beforeEach(async () => {
      await cp?.end().catch(() => {});
      await school?.end().catch(() => {});
      cp = await newDb("cp_bill");
      await cp.query(readFileSync("tests/sql/prelude.sql", "utf8"));
      for (const f of readdirSync("supabase/migrations").sort())
        await cp.query(readFileSync(join("supabase/migrations", f), "utf8"));
      school = await newDb("school_bill");
      await school.query(STAND_IN_SCHOOL_DB);
      const client = pgSupabase(cp);
      rpc = client.rpc.bind(client) as typeof rpc;

      await cp.query(
        "insert into schools (slug, name, status, hostnames, supabase_project_ref) values ('alpha', 'Alpha Academy', 'active', '{alpha.example.com}', 'refalpha')"
      );
      schoolId = (await one("select id from schools where slug = 'alpha'")).id;
      for (const [item, amount, count] of [
        ["base_fee", 15_000_000, null],
        ["included_students", null, 300],
        ["extra_student", 5_000, null],
        ["feature:sms_alerts", 500_000, null],
      ] as const) {
        await call("set_price", {
          p_item: item,
          p_amount_kobo: amount,
          p_count: count,
          p_effective_from: null,
          p_reason: "launch",
          p_by: "owner",
        });
      }
      keys = generateClaimKeyPair();
      await call("add_school_signing_key", {
        p_school: schoolId,
        p_public_key: keys.publicKey,
        p_by: "owner",
      });

      sent = [];
      connectFails = 0;
      telegramOn = true;
      const url = "postgres://u:pw-alpha-123@alpha.db/x";
      const ok: DeployOutcome = { ok: true, code: 0, status: "ok", tag: "", message: "" };
      deps = {
        workerId: "w-test",
        store: new SupabaseStore("http://unused", "unused", client),
        secrets: new EnvSecrets(JSON.stringify({ alpha: url })),
        connect: async () => {
          if (connectFails > 0) {
            connectFails--;
            throw new Error(`connect ECONNREFUSED ${url}`);
          }
          return { db: school, close: async () => {} };
        },
        deploy: async () => ok,
        probe: async () => ({
          ok: true,
          httpStatus: 200,
          latencyMs: 1,
          version: null,
          error: null,
        }),
        backup: fakeBackup(),
        backupKeep: 3,
        telegram: undefined,
        log: () => {},
        heartbeatMs: 60_000,
      } as WorkerDeps;
      Object.defineProperty(deps, "telegram", {
        get: () =>
          telegramOn
            ? { send: async (t: string) => void sent.push(t), appUrl: "https://dash.example.com" }
            : undefined,
      });
    });

    it("takes a payment from quote to licence: invoice, signed claim, notice, confirm, push", async () => {
      const { id, qt, row } = await invoice();
      expect(qt.total_kobo).toBe(15_000_000 + 20 * 5_000 + 500_000);
      expect(row).toMatchObject({ status: "pending", amount_kobo: String(qt.total_kobo) });

      // the school claims it, signed
      const res = await post(claimBody(row.reference, qt.total_kobo));
      expect(res.status).toBe(201);
      const claimId = (res.body as { claim_id: string }).claim_id;
      expect((await sub(id)).status).toBe("pending_confirmation");
      expect(
        (await q(cp, "select action, actor_email from audit_log where action = 'claim.submit'"))[0]
      ).toMatchObject({ actor_email: "school:alpha" });

      // the worker tells you on Telegram, and stamps the claim
      expect(await drain()).toBe(1);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toContain("Alpha Academy");
      expect(sent[0]).toContain("₦156,000.00");
      expect(sent[0]).toContain(row.reference);
      expect(
        (await one("select notified_at from payment_claims where id = $1", [claimId])).notified_at
      ).not.toBeNull();
      expect((await jobs("telegram_notify"))[0].status).toBe("succeeded");

      // nothing has touched the licence yet
      expect(
        (await one("select license_version from schools where id = $1", [schoolId])).license_version
      ).toBe("0");
      expect(await q(school, "select * from school_license")).toEqual([]);

      // a person checks the bank and confirms
      await call("confirm_claim", {
        p_claim: claimId,
        p_amount_kobo: qt.total_kobo,
        p_by: "finance@example.com",
        p_reason: "statement line 41",
      });
      expect((await sub(id)).status).toBe("paid");
      expect(await drain()).toBe(1);

      // the licence is in the school's own database
      const lic = (await q(school, "select * from school_license"))[0];
      expect(lic).toMatchObject({
        school_id: schoolId,
        version: "1",
        session: "2026/2027",
        student_cap: 320,
        features: ["sms_alerts"],
        is_trial: false,
      });
      expect(new Date(lic.valid_until).getTime()).toBeGreaterThan(Date.now() + 290 * 86_400_000);
      const reg = await one(
        "select license_version, license_pushed_version, license_pushed_at, license_push_error from schools where id = $1",
        [schoolId]
      );
      expect(reg).toMatchObject({
        license_version: "1",
        license_pushed_version: "1",
        license_push_error: null,
      });
      expect(reg.license_pushed_at).not.toBeNull();
      expect((await jobs("license_push"))[0].status).toBe("succeeded");
    });

    it("treats a retried signed claim as the same claim, and sends one notice", async () => {
      const { row, qt } = await invoice();
      const a = await post(claimBody(row.reference, qt.total_kobo));
      const b = await post(claimBody(row.reference, qt.total_kobo));
      expect(a.status).toBe(201);
      expect(b.status).toBe(201);
      expect((b.body as { claim_id: string }).claim_id).toBe(
        (a.body as { claim_id: string }).claim_id
      );
      expect(await q(cp, "select 1 from payment_claims")).toHaveLength(1);
      await drain();
      expect(sent).toHaveLength(1);
    });

    it("refuses a claim signed with the wrong key, or too late, and records nothing", async () => {
      const { row, qt } = await invoice();
      expect(
        (
          await post(claimBody(row.reference, qt.total_kobo), {
            key: generateClaimKeyPair().privateKey,
          })
        ).status
      ).toBe(401);
      expect(
        (
          await post(claimBody(row.reference, qt.total_kobo), {
            at: Math.floor(Date.now() / 1000) - 3600,
          })
        ).status
      ).toBe(401);
      await call("add_school_signing_key", {
        p_school: schoolId,
        p_public_key: generateClaimKeyPair().publicKey,
        p_by: "owner",
      });
      expect(await q(cp, "select 1 from payment_claims")).toEqual([]);
      expect(await q(cp, "select 1 from audit_log where action = 'claim.submit'")).toEqual([]);
    });

    it("stops accepting a key once it is revoked", async () => {
      const { row, qt } = await invoice();
      const k = await one("select id from school_signing_keys limit 1");
      await call("revoke_school_signing_key", { p_key: k.id });
      expect((await post(claimBody(row.reference, qt.total_kobo))).status).toBe(401);
    });

    it("refuses to confirm the wrong amount, leaves the invoice waiting, and lets a rejected school claim again", async () => {
      const { id, row, qt } = await invoice();
      const claimId = (
        (await post(claimBody(row.reference, qt.total_kobo))).body as { claim_id: string }
      ).claim_id;
      await expect(
        call("confirm_claim", {
          p_claim: claimId,
          p_amount_kobo: qt.total_kobo - 100,
          p_by: "f",
          p_reason: "x",
        })
      ).rejects.toThrow(/does not match the invoice/);
      expect((await sub(id)).status).toBe("pending_confirmation");
      await call("reject_claim", {
        p_claim: claimId,
        p_by: "finance@example.com",
        p_reason: "not on the statement",
      });
      expect((await sub(id)).status).toBe("pending");
      const again = await post(
        claimBody(row.reference, qt.total_kobo, { client_ref: "claim-0002" })
      );
      expect(again.status).toBe(201);
      expect(await q(cp, "select status from payment_claims order by created_at")).toEqual([
        { status: "rejected" },
        { status: "pending" },
      ]);
    });

    it("answers a claim for something already paid with the reason, and does not pay twice", async () => {
      const { id, row, qt } = await invoice();
      const claimId = (
        (await post(claimBody(row.reference, qt.total_kobo))).body as { claim_id: string }
      ).claim_id;
      await call("confirm_claim", {
        p_claim: claimId,
        p_amount_kobo: qt.total_kobo,
        p_by: "f",
        p_reason: "checked",
      });
      const late = await post(
        claimBody(row.reference, qt.total_kobo, { client_ref: "claim-0003" })
      );
      expect(late).toMatchObject({ status: 409 });
      expect(String(late.body.error)).toMatch(/already been paid/);
      expect((await sub(id)).status).toBe("paid");
    });

    it("reminds you once if a claim is still waiting after 48 hours", async () => {
      const { row, qt } = await invoice();
      const claimId = (
        (await post(claimBody(row.reference, qt.total_kobo))).body as { claim_id: string }
      ).claim_id;
      await drain();
      sent.length = 0;
      expect(await deps.store.enqueueClaimReminders()).toBe(0);
      await cp.query(
        "update payment_claims set created_at = now() - interval '50 hours' where id = $1",
        [claimId]
      );
      expect(await deps.store.enqueueClaimReminders()).toBe(1);
      expect(await deps.store.enqueueClaimReminders()).toBe(0);
      await drain();
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatch(/Reminder: a transfer claim has waited 50 hours/);
      expect(await deps.store.enqueueClaimReminders()).toBe(0);
      // once decided, no further reminder is ever sent
      await call("reject_claim", { p_claim: claimId, p_by: "f", p_reason: "no" });
      expect(await deps.store.enqueueClaimReminders()).toBe(0);
    });

    it("never blocks the claim when Telegram is not set up: the notice fails visibly, the claim waits", async () => {
      telegramOn = false;
      const { row, qt } = await invoice();
      const res = await post(claimBody(row.reference, qt.total_kobo));
      expect(res.status).toBe(201);
      await drain();
      const [job] = await jobs("telegram_notify");
      expect(job.status).toBe("failed");
      expect(job.error).toMatch(/TELEGRAM_BOT_TOKEN/);
      expect((await one("select status from payment_claims")).status).toBe("pending");
    });

    it("retries a licence push that cannot reach the school, shows the error, then clears it", async () => {
      const { qt, row } = await invoice();
      const claimId = (
        (await post(claimBody(row.reference, qt.total_kobo))).body as { claim_id: string }
      ).claim_id;
      await drain();
      await call("confirm_claim", {
        p_claim: claimId,
        p_amount_kobo: qt.total_kobo,
        p_by: "f",
        p_reason: "ok",
      });

      connectFails = 1;
      await tick(deps);
      let reg = await one(
        "select license_version, license_pushed_version, license_push_error from schools where id = $1",
        [schoolId]
      );
      expect(reg).toMatchObject({ license_version: "1", license_pushed_version: "0" });
      expect(reg.license_push_error).toMatch(/ECONNREFUSED/);
      expect(reg.license_push_error).not.toContain("pw-alpha-123");
      expect((await jobs("license_push"))[0]).toMatchObject({ status: "queued", attempts: 1 });
      expect(await q(school, "select * from school_license")).toEqual([]);

      await cp.query("update jobs set run_after = now() where type = 'license_push'");
      await tick(deps);
      reg = await one(
        "select license_pushed_version, license_push_error from schools where id = $1",
        [schoolId]
      );
      expect(reg).toMatchObject({ license_pushed_version: "1", license_push_error: null });
      expect((await q(school, "select version from school_license"))[0].version).toBe("1");
      expect((await jobs("license_push"))[0].status).toBe("succeeded");
    });

    it("marks paid without a claim, and an extension makes the next licence version", async () => {
      const { id, row } = await invoice();
      await call("mark_subscription_paid", {
        p_sub: id,
        p_ref: "",
        p_by: "owner",
        p_reason: "cash at the office",
      });
      expect((await sub(id)).payment_ref).toBe(row.reference);
      await drain();
      expect((await q(school, "select version from school_license"))[0].version).toBe("1");

      const later = new Date(Date.now() + 400 * 86_400_000).toISOString();
      await call("extend_subscription", {
        p_sub: id,
        p_valid_until: later,
        p_grace_until: new Date(Date.now() + 414 * 86_400_000).toISOString(),
        p_by: "owner",
        p_reason: "goodwill",
      });
      await drain();
      const lic = (await q(school, "select version, valid_until from school_license"))[0];
      expect(lic.version).toBe("2");
      expect(new Date(lic.valid_until).toISOString()).toBe(later);
      expect(
        (await one("select license_pushed_version from schools where id = $1", [schoolId]))
          .license_pushed_version
      ).toBe("2");
    });

    it("does not move the school's licence backwards if an older version is pushed late", async () => {
      const { id } = await invoice();
      await call("mark_subscription_paid", {
        p_sub: id,
        p_ref: "",
        p_by: "owner",
        p_reason: "paid",
      });
      await drain();
      await call("extend_subscription", {
        p_sub: id,
        p_valid_until: new Date(Date.now() + 400 * 86_400_000).toISOString(),
        p_grace_until: new Date(Date.now() + 414 * 86_400_000).toISOString(),
        p_by: "owner",
        p_reason: "goodwill",
      });
      await drain();
      // the school ignores a stale version outright (set_license returns false)
      const stale = await q(
        school,
        "select set_license($1, 1, 'old', now(), now(), 1, '{}', false) as applied",
        [schoolId]
      );
      expect(stale[0].applied).toBe(false);
      expect((await q(school, "select version from school_license"))[0].version).toBe("2");
    });

    it("answers 429 once a school sends too many claims, using the real counter", async () => {
      // Invalid bodies still count: they pass the signature, then fail validation.
      for (let i = 0; i < 10; i++) {
        expect((await post({ nonsense: i })).status).toBe(400);
      }
      const res = await post({ nonsense: 11 });
      expect(res.status).toBe(429);
      expect(res.headers).toEqual({ "retry-after": "600" });
      expect(
        (await q(cp, "select hits from rate_limit_hits where bucket like 'claim:school:%'"))[0].hits
      ).toBe(11);
    });

    it("raises the school's allowance with a paid top-up and pushes it", async () => {
      const { id } = await invoice(0);
      await call("mark_subscription_paid", { p_sub: id, p_ref: "", p_by: "f", p_reason: "paid" });
      await drain();
      const topup = (await call("create_topup", {
        p_sub: id,
        p_extra: 12,
        p_amount: 12 * 5_000,
        p_line: JSON.stringify({ item: "extra_student", unit_kobo: 5_000 }),
        p_by: "finance",
      })) as string;
      await call("mark_topup_paid", {
        p_topup: topup,
        p_amount_kobo: 60_000,
        p_ref: "NIP77",
        p_by: "finance",
        p_reason: "on the statement",
      });
      await drain();
      const row = (await q(school, "select version, student_cap from school_license"))[0];
      expect(row).toMatchObject({ version: "2", student_cap: 312 });
      expect(
        await one("select license_push_error from schools where id = $1", [schoolId])
      ).toMatchObject({
        license_push_error: null,
      });
    });

    it("ends the school's licence in its own database when a payment is refunded", async () => {
      const { id, qt } = await invoice(0);
      await call("mark_subscription_paid", { p_sub: id, p_ref: "", p_by: "f", p_reason: "paid" });
      await drain();
      const refunded = await call("refund_subscription", {
        p_sub: id,
        p_by: "owner",
        p_reason: "paid by mistake",
        p_window_days: 14,
      });
      expect(Number(refunded)).toBe(qt.total_kobo);
      await drain();
      const lic = (
        await q(school, "select version, valid_until, grace_until from school_license")
      )[0];
      expect(lic.version).toBe("2");
      expect(new Date(lic.valid_until).getTime()).toBeLessThanOrEqual(Date.now());
      expect(new Date(lic.grace_until).getTime()).toBeLessThanOrEqual(Date.now());
    });

    it("suspends a long-lapsed school through the store, and a confirmed payment lifts it", async () => {
      await cp.query(
        "update schools set license_valid_until = now() - interval '200 days', license_grace_until = now() - interval '120 days' where id = $1",
        [schoolId]
      );
      const done = await deps.store.suspendLapsedSchools(90);
      expect(done.map((d) => d.slug)).toEqual(["alpha"]);
      expect(
        await one("select status, suspended_reason from schools where id = $1", [schoolId])
      ).toEqual({
        status: "suspended",
        suspended_reason: "lapsed",
      });
      expect(await deps.store.suspendLapsedSchools(90)).toEqual([]);

      // The school pays an invoice made before it was suspended.
      await cp.query(
        "update schools set status = 'active', suspended_reason = null where id = $1",
        [schoolId]
      );
      const { id } = await invoice(0);
      await cp.query(
        "update schools set status = 'suspended', suspended_reason = 'lapsed', suspended_at = now() where id = $1",
        [schoolId]
      );
      await call("mark_subscription_paid", { p_sub: id, p_ref: "", p_by: "f", p_reason: "paid" });
      expect((await one("select status from schools where id = $1", [schoolId])).status).toBe(
        "active"
      );
    });

    // ------------------------------------------------------------- card payments
    const PAYSTACK_SECRET = "sk_test_0123456789abcdef";
    const checkout = async (reference: string, over: Record<string, unknown> = {}) => {
      const raw = JSON.stringify({
        subscription_reference: reference,
        payer_email: "bursar@alpha.example",
        return_url: "https://alpha.example/renewal",
        ...over,
      });
      const ts = Math.floor(Date.now() / 1000);
      let sent: { reference: string; amountKobo: number } | null = null;
      const res = await handleCheckout(
        {
          slug: "alpha",
          timestamp: String(ts),
          signature: signClaim({
            privateKey: keys.privateKey,
            slug: "alpha",
            timestamp: ts,
            body: raw,
            purpose: "checkout-v1",
          }),
          rawBody: raw,
          ip: "203.0.113.7",
        },
        {
          ...authDeps,
          configured: true,
          begin: async (schoolId, ref, email) => {
            const r = await rpc("paystack_begin", {
              p_school: schoolId,
              p_reference: ref,
              p_email: email,
            });
            if (r.error) return { businessError: r.error.message };
            const row = (r.data as { reference: string; amount_kobo: string }[])[0];
            return { reference: row.reference, amountKobo: Number(row.amount_kobo) };
          },
          initialize: async (p) => {
            sent = { reference: p.reference, amountKobo: p.amountKobo };
            return { authorizationUrl: "https://checkout.paystack.com/test" };
          },
          audit: async () => {},
        }
      );
      return { res, sent: sent as { reference: string; amountKobo: number } | null };
    };
    const webhook = async (
      reference: string,
      amount: number,
      id = 4099260516,
      currency = "NGN"
    ) => {
      const raw = JSON.stringify({
        event: "charge.success",
        data: { id, reference, amount, currency, status: "success" },
      });
      return handlePaystackWebhook(
        { rawBody: raw, signature: paystackSignature(raw, PAYSTACK_SECRET) },
        {
          secret: PAYSTACK_SECRET,
          recordCharge: async (c) => {
            const r = await rpc("paystack_record_charge", {
              p_reference: c.reference,
              p_paystack_id: c.paystackId,
              p_paid_kobo: c.amountKobo,
              p_currency: c.currency,
            });
            if (r.error) throw new Error(r.error.message);
            return r.data as "applied" | "duplicate" | "needs_review" | "unknown";
          },
          audit: async () => {},
        }
      );
    };

    it("takes a card payment from checkout to a licence in the school's own database", async () => {
      const { id, row, qt } = await invoice(0);
      const { res, sent } = await checkout(row.reference as string);
      expect(res.status).toBe(201);
      expect(sent).toMatchObject({ amountKobo: qt.total_kobo });
      const ref = (res.body as { reference: string }).reference;
      expect(ref).toMatch(/^PSK-[0-9A-F]{16}$/);
      // Not paid until Paystack says so.
      expect((await sub(id)).status).toBe("pending");

      expect((await webhook(ref, qt.total_kobo)).body).toEqual({ ok: true, result: "applied" });
      expect(await sub(id)).toMatchObject({ status: "paid", method: "paystack", payment_ref: ref });
      await drain();
      const lic = (await q(school, "select version, valid_until from school_license"))[0];
      expect(lic.version).toBe("1");
      expect(new Date(lic.valid_until).getTime()).toBeGreaterThan(Date.now());

      // Paystack resends the same webhook: nothing changes.
      expect((await webhook(ref, qt.total_kobo)).body).toEqual({ ok: true, result: "duplicate" });
      expect(await q(cp, "select 1 from jobs where type = 'license_push'")).toHaveLength(1);
    });

    it("flags a short card payment for a person, leaves the invoice open and queues a notice", async () => {
      const { id, row, qt } = await invoice(0);
      const ref = ((await checkout(row.reference as string)).res.body as { reference: string })
        .reference;
      expect((await webhook(ref, qt.total_kobo - 100)).body).toEqual({
        ok: true,
        result: "needs_review",
      });
      expect((await sub(id)).status).toBe("pending");
      const n = await q(
        cp,
        "select payload from jobs where type = 'telegram_notify' and payload ->> 'kind' = 'paystack_review'"
      );
      expect(n).toHaveLength(1);
      expect(n[0].payload.message).toContain(row.reference);
      expect(await q(cp, "select 1 from jobs where type = 'license_push'")).toHaveLength(0);
    });

    it("will not start a checkout for an invoice that is paid or has a claim waiting", async () => {
      const { id, row } = await invoice(0);
      await post(claimBody(row.reference as string, Number(row.amount_kobo)));
      expect((await checkout(row.reference as string)).res).toMatchObject({
        status: 409,
        body: { error: expect.stringContaining("already waiting to be confirmed") },
      });
      await call("reject_claim", {
        p_claim: (await one("select id from payment_claims")).id,
        p_by: "f",
        p_reason: "x",
      });
      await call("mark_subscription_paid", { p_sub: id, p_ref: "", p_by: "f", p_reason: "paid" });
      expect((await checkout(row.reference as string)).res).toMatchObject({
        status: 409,
        body: { error: "That invoice has already been paid." },
      });
    });

    it("accepts a claim that names a proof this school was given, and refuses another school's", async () => {
      const { row } = await invoice(0);
      const UUID = "123e4567-e89b-42d3-a456-426614174000";
      const bad = await post(
        claimBody(row.reference as string, Number(row.amount_kobo), {
          proof_path: `proofs/othertown/${UUID}.jpg`,
        })
      );
      expect(bad.status).toBe(400);
      expect(await q(cp, "select 1 from payment_claims")).toHaveLength(0);
      const ok = await post(
        claimBody(row.reference as string, Number(row.amount_kobo), {
          proof_path: `proofs/alpha/${UUID}.jpg`,
        })
      );
      expect(ok.status).toBe(201);
      expect((await one("select proof_path from payment_claims")).proof_path).toBe(
        `proofs/alpha/${UUID}.jpg`
      );
    });
  }
);
