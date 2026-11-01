import { describe, expect, it, vi } from "vitest";
import { EnvSecrets } from "@/worker/secrets";
import type { HandlerDeps } from "@/worker/handlers";
import { handleInvoiceReminder, type ReminderDeps } from "@/worker/reminders";
import type { InvoiceForReminder } from "@/worker/store";
import { fakeStore, job } from "@/tests/helpers/fake-store";

const SUB = "11111111-2222-3333-4444-555555555555";
const secrets = new EnvSecrets(JSON.stringify({}));

const invoice = (over: Partial<InvoiceForReminder> = {}): InvoiceForReminder => ({
  id: SUB,
  status: "pending",
  reference: "INV-2026-0007",
  session: "2026/2027",
  amount_kobo: 25_000_000,
  school_name: "Greenfield Academy",
  school_slug: "greenfield",
  school_status: "active",
  billing_contact_name: "Mrs Okoye",
  billing_contact_email: "bursar@greenfield.example",
  hostname: "greenfield.example.ng",
  license_valid_until: "2026-11-15T00:00:00Z",
  license_grace_until: "2026-11-29T00:00:00Z",
  current_kind: "before_14",
  sent_kinds: [],
  ...over,
});

function setup(inv: InvoiceForReminder | null, over: Partial<ReminderDeps> = {}) {
  const send = vi.fn(async () => {});
  const tg = vi.fn(async () => {});
  const store = fakeStore({ invoiceForReminder: vi.fn(async () => inv) });
  const deps: HandlerDeps & ReminderDeps = {
    store,
    secrets,
    connect: vi.fn(),
    deploy: vi.fn(),
    probe: vi.fn(),
    log: () => {},
    telegram: { send: tg },
    email: { apiKey: "re_key_1234567", from: "billing@example.com", send },
    supportEmail: "help@example.com",
    now: () => new Date("2026-11-01T00:00:00Z"),
    ...over,
  } as unknown as HandlerDeps & ReminderDeps;
  const run = (payload: Record<string, unknown> = { subscription_id: SUB, kind: "before_14" }) =>
    handleInvoiceReminder(job({ type: "invoice_reminder", school_id: "s1", payload }), deps);
  return { store, send, tg, run };
}

describe("handleInvoiceReminder", () => {
  it("emails the contact, records the stage, then tells the owner", async () => {
    const { store, send, tg, run } = setup(invoice());
    const out = await run();
    expect(out).toEqual({
      ok: true,
      result: { kind: "before_14", sent_to: "bursar@greenfield.example" },
    });
    expect(send).toHaveBeenCalledTimes(1);
    const [, msg] = send.mock.calls[0] as unknown as [
      unknown,
      { to: string; idempotencyKey: string },
    ];
    expect(msg.to).toBe("bursar@greenfield.example");
    expect(msg.idempotencyKey).toBe(`invoice-reminder-${SUB}-before_14`);
    expect(store.markInvoiceReminded).toHaveBeenCalledWith(
      SUB,
      "before_14",
      "bursar@greenfield.example"
    );
    expect(tg).toHaveBeenCalledTimes(1);
  });

  it("does not record the stage when the email fails, so it is tried again", async () => {
    const { store, run } = setup(invoice(), {
      email: {
        apiKey: "k",
        from: "b@example.com",
        send: async () => {
          throw new Error("provider down");
        },
      },
    });
    await expect(run()).rejects.toThrow("provider down");
    expect(store.markInvoiceReminded).not.toHaveBeenCalled();
  });

  it("still succeeds when the Telegram notice fails", async () => {
    const { store, run } = setup(invoice(), {
      telegram: {
        send: async () => {
          throw new Error("telegram down");
        },
      },
    } as Partial<ReminderDeps>);
    const out = await run();
    expect(out.ok).toBe(true);
    expect(store.markInvoiceReminded).toHaveBeenCalled();
  });

  it("fails visibly, sending nothing, when email is not set up but a contact exists", async () => {
    const { store, run } = setup(invoice(), { email: undefined });
    const out = await run();
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/RESEND_API_KEY/);
    expect(store.markInvoiceReminded).not.toHaveBeenCalled();
  });

  it("with no contact email records the stage with no address and tells the owner", async () => {
    const { store, send, tg, run } = setup(invoice({ billing_contact_email: null }), {
      email: undefined,
    });
    const out = await run();
    expect(out).toEqual({ ok: true, result: { kind: "before_14", sent_to: null } });
    expect(send).not.toHaveBeenCalled();
    expect(store.markInvoiceReminded).toHaveBeenCalledWith(SUB, "before_14", null);
    expect((tg.mock.calls[0] as unknown as [string])[0]).toContain("No billing contact email");
  });

  it.each([
    ["paid", { status: "paid" }],
    ["cancelled", { status: "cancelled" }],
    ["suspended school", { school_status: "suspended" }],
    ["already sent", { sent_kinds: ["before_14"] as InvoiceForReminder["sent_kinds"] }],
    ["stage moved on", { current_kind: "before_3" as const }],
    ["no stage now", { current_kind: null }],
    ["no licence dates", { license_valid_until: null }],
  ])("sends nothing and succeeds when: %s", async (_name, over) => {
    const { store, send, run } = setup(invoice(over as Partial<InvoiceForReminder>));
    const out = await run();
    expect(out.ok).toBe(true);
    expect(out.result).toHaveProperty("skipped");
    expect(send).not.toHaveBeenCalled();
    expect(store.markInvoiceReminded).not.toHaveBeenCalled();
  });

  it("refuses a malformed job and a missing invoice", async () => {
    const a = setup(invoice());
    expect((await a.run({ subscription_id: "nope", kind: "before_14" })).ok).toBe(false);
    expect((await a.run({ subscription_id: SUB, kind: "bogus" })).ok).toBe(false);
    const b = setup(null);
    expect(await b.run()).toEqual({ ok: false, error: "That invoice does not exist." });
  });
});
