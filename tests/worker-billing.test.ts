import { describe, expect, it, vi } from "vitest";
import {
  handleLicensePush,
  handleTelegramNotify,
  type HandlerDeps,
  type SchoolConnection,
} from "@/worker/handlers";
import { EnvSecrets } from "@/worker/secrets";
import type { ClaimForNotice, LicenseForPush } from "@/worker/store";
import { fakeStore, job } from "@/tests/helpers/fake-store";

const DB_URL = "postgres://postgres:s3cretPassw0rd@db.example.supabase.co:5432/postgres";
const secrets = new EnvSecrets(JSON.stringify({ greenfield: DB_URL }));

const lic = (over: Partial<LicenseForPush> = {}): LicenseForPush => ({
  id: "school-1",
  slug: "greenfield",
  license_version: 3,
  license_pushed_version: 2,
  license_session: "2026/2027",
  license_is_trial: false,
  license_valid_until: "2027-07-31T23:59:59Z",
  license_grace_until: "2027-08-14T23:59:59Z",
  included_students: 320,
  features: ["parent_app", "sms_alerts"],
  ...over,
});

function connection(query: SchoolConnection["db"]["query"]) {
  const close = vi.fn(async () => {});
  return { conn: { db: { query }, close } as unknown as SchoolConnection, close };
}

function pushSetup(
  l: LicenseForPush | null,
  query: (...a: unknown[]) => Promise<unknown> = async () => ({ rows: [{ applied: true }] })
) {
  const store = fakeStore({ licenseForPush: vi.fn(async () => l) });
  const { conn, close } = connection(query as never);
  const connect = vi.fn(async () => conn);
  const deps = { store, secrets, connect, log: () => {} } as unknown as HandlerDeps;
  return { store, deps, connect, close, query };
}
const pushJob = job({
  type: "license_push",
  school_id: "school-1",
  payload: { subscription_id: "s1" },
});

describe("handleLicensePush", () => {
  it("calls the school's set_license with exactly what the registry holds, then records success", async () => {
    const query = vi.fn(async () => ({ rows: [{ applied: true }] }));
    const { store, deps, close } = pushSetup(lic(), query);
    expect(await handleLicensePush(pushJob, deps)).toEqual({
      ok: true,
      result: { version: 3, applied: true },
    });
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toMatch(/select set_license\(/);
    expect(params).toEqual([
      "school-1",
      3,
      "2026/2027",
      "2027-07-31T23:59:59Z",
      "2027-08-14T23:59:59Z",
      320,
      ["parent_app", "sms_alerts"],
      false,
    ]);
    expect(store.recordLicensePush).toHaveBeenCalledWith("school-1", 3, true, null);
    expect(close).toHaveBeenCalled();
  });

  it("sends no student cap when the school has none, and passes a trial flag through", async () => {
    const query = vi.fn(async () => ({ rows: [{ applied: true }] }));
    const { deps } = pushSetup(lic({ included_students: 0, license_is_trial: true }), query);
    await handleLicensePush(pushJob, deps);
    const params = (query.mock.calls[0] as unknown as [string, unknown[]])[1];
    expect(params[5]).toBeNull();
    expect(params[7]).toBe(true);
  });

  it("counts a school that already has this or a newer version as in step", async () => {
    const { store, deps } = pushSetup(lic(), async () => ({ rows: [{ applied: false }] }));
    expect(await handleLicensePush(pushJob, deps)).toEqual({
      ok: true,
      result: { version: 3, applied: false },
    });
    expect(store.recordLicensePush).toHaveBeenCalledWith("school-1", 3, true, null);
  });

  it("does nothing when this version has already been pushed", async () => {
    const { deps, connect } = pushSetup(lic({ license_pushed_version: 3 }));
    expect(await handleLicensePush(pushJob, deps)).toEqual({
      ok: true,
      result: { skipped: "already pushed", version: 3 },
    });
    expect(connect).not.toHaveBeenCalled();
  });

  it("records the failure on the registry row, hides the password, and throws so the job is retried", async () => {
    const { store, deps, close } = pushSetup(lic(), async () => {
      throw new Error(`connection to ${DB_URL} refused`);
    });
    const err = await handleLicensePush(pushJob, deps).catch((e) => e);
    expect(err.message).toMatch(/Licence push for greenfield failed/);
    expect(err.message).not.toContain("s3cretPassw0rd");
    const [, , ok, recorded] = (store.recordLicensePush as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(ok).toBe(false);
    expect(String(recorded)).not.toContain("s3cretPassw0rd");
    expect(close).toHaveBeenCalled();
  });

  it("fails clearly when the school's connection cannot even be opened", async () => {
    const store = fakeStore({ licenseForPush: vi.fn(async () => lic()) });
    const deps = {
      store,
      secrets,
      connect: vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
      log: () => {},
    } as unknown as HandlerDeps;
    await expect(handleLicensePush(pushJob, deps)).rejects.toThrow(/ECONNREFUSED/);
    expect(store.recordLicensePush).toHaveBeenCalledWith(
      "school-1",
      3,
      false,
      expect.stringContaining("ECONNREFUSED")
    );
  });

  it("refuses without a school, with an unknown school, or with no licence saved", async () => {
    expect(
      (
        await handleLicensePush(
          job({ type: "license_push", school_id: null }),
          pushSetup(lic()).deps
        )
      ).error
    ).toMatch(/no school/);
    expect((await handleLicensePush(pushJob, pushSetup(null).deps)).error).toMatch(
      /does not exist/
    );
    expect(
      (await handleLicensePush(pushJob, pushSetup(lic({ license_session: null })).deps)).error
    ).toMatch(/no licence saved/);
  });
});

const claim = (over: Partial<ClaimForNotice> = {}): ClaimForNotice => ({
  id: "claim-1",
  status: "pending",
  amount_kobo: 15_000_000,
  sent_on: "2026-10-24",
  created_at: new Date(Date.now() - 50 * 3_600_000).toISOString(),
  notified_at: null,
  reminded_at: null,
  reference: "SUB-0A1B2C3D",
  session: "2026/2027",
  school_name: "Greenfield Academy",
  ...over,
});
function notifySetup(c: ClaimForNotice | null, send = vi.fn(async () => {}), configured = true) {
  const store = fakeStore({ claimForNotice: vi.fn(async () => c) });
  const deps = {
    store,
    secrets,
    log: () => {},
    telegram: configured ? { send, appUrl: "https://dash.example.com" } : undefined,
  } as unknown as HandlerDeps;
  return { store, deps, send };
}
const notifyJob = (kind = "claim") =>
  job({ type: "telegram_notify", school_id: "school-1", payload: { kind, claim_id: "claim-1" } });

describe("handleTelegramNotify", () => {
  it("sends the notice for a new claim, then stamps it", async () => {
    const { store, deps, send } = notifySetup(claim());
    expect(await handleTelegramNotify(notifyJob(), deps)).toEqual({
      ok: true,
      result: { sent: "claim" },
    });
    const text = (send.mock.calls[0] as unknown as [string])[0];
    expect(text).toMatch(/New transfer claim/);
    expect(text).toContain("Greenfield Academy");
    expect(text).toContain("₦150,000.00");
    expect(text).toContain("https://dash.example.com/billing");
    expect(store.markClaimNotified).toHaveBeenCalledWith("claim-1", "claim");
  });

  it("sends a reminder that says how long it has waited", async () => {
    const { store, deps, send } = notifySetup(claim());
    await handleTelegramNotify(notifyJob("reminder"), deps);
    expect((send.mock.calls[0] as unknown as [string])[0]).toMatch(
      /Reminder: a transfer claim has waited 50 hours/
    );
    expect(store.markClaimNotified).toHaveBeenCalledWith("claim-1", "reminder");
  });

  it("does not ping about a claim that has been decided, or one it already announced", async () => {
    for (const c of [claim({ status: "confirmed" }), claim({ status: "rejected" })]) {
      const { deps, send } = notifySetup(c);
      expect((await handleTelegramNotify(notifyJob("reminder"), deps)).result).toEqual({
        skipped: `already ${c.status}`,
      });
      expect(send).not.toHaveBeenCalled();
    }
    const done = notifySetup(claim({ notified_at: "2026-10-25T08:00:00Z" }));
    expect((await handleTelegramNotify(notifyJob(), done.deps)).result).toEqual({
      skipped: "already sent",
    });
    expect(done.send).not.toHaveBeenCalled();
    const again = notifySetup(claim({ reminded_at: "2026-10-27T08:00:00Z" }));
    expect((await handleTelegramNotify(notifyJob("reminder"), again.deps)).result).toEqual({
      skipped: "already sent",
    });
  });

  it("still sends the first notice for a claim that has already had its reminder stamped", async () => {
    const { deps, send } = notifySetup(claim({ reminded_at: "2026-10-27T08:00:00Z" }));
    await handleTelegramNotify(notifyJob("claim"), deps);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("says so, without crashing, when Telegram is not configured", async () => {
    const { deps, store } = notifySetup(claim(), undefined, false);
    const out = await handleTelegramNotify(notifyJob(), deps);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID/);
    expect(store.claimForNotice).not.toHaveBeenCalled();
  });

  it("lets a send failure propagate so the job is retried, and does not stamp the claim", async () => {
    const { deps, store } = notifySetup(
      claim(),
      vi.fn(async () => {
        throw new Error("Telegram answered 429.");
      })
    );
    await expect(handleTelegramNotify(notifyJob(), deps)).rejects.toThrow(/429/);
    expect(store.markClaimNotified).not.toHaveBeenCalled();
  });

  it("fails clearly for a claim that does not exist", async () => {
    expect((await handleTelegramNotify(notifyJob(), notifySetup(null).deps)).error).toMatch(
      /does not exist/
    );
  });
});
