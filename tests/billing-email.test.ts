import { describe, expect, it, vi } from "vitest";
import { isEmailAddress, sendEmail } from "@/lib/billing/email";

const cfg = { apiKey: "re_secretkey123456", from: "Billing <billing@example.com>" };
const msg = { to: "bursar@school.example", subject: "Hello", text: "Body" };
const ok = () => new Response("{}", { status: 200 });

describe("isEmailAddress", () => {
  it.each(["a@b.co", " a@b.co "])("accepts %s", (v) => expect(isEmailAddress(v)).toBe(true));
  it.each(["", "a@b", "a b@c.de", "<a@b.co>", null, undefined])("rejects %s", (v) =>
    expect(isEmailAddress(v as string)).toBe(false)
  );
});

describe("sendEmail", () => {
  it("posts plain text to Resend with auth and an idempotency key", async () => {
    const f = vi.fn(async () => ok());
    await sendEmail(cfg, { ...msg, idempotencyKey: "k1" }, f as unknown as typeof fetch);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    const h = init.headers as Record<string, string>;
    expect(h.authorization).toBe(`Bearer ${cfg.apiKey}`);
    expect(h["idempotency-key"]).toBe("k1");
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ from: cfg.from, to: [msg.to], subject: "Hello", text: "Body" });
    expect(body.html).toBeUndefined();
    expect(body.reply_to).toBeUndefined();
  });

  it("includes reply_to only when configured, and flattens line breaks in the subject", async () => {
    const f = vi.fn(async () => ok());
    await sendEmail(
      { ...cfg, replyTo: "help@example.com" },
      { ...msg, subject: "A\r\nBcc: x@y.z" },
      f as unknown as typeof fetch
    );
    const body = JSON.parse(
      (f.mock.calls[0] as unknown as [string, RequestInit])[1].body as string
    );
    expect(body.reply_to).toBe("help@example.com");
    expect(body.subject).toBe("A Bcc: x@y.z");
  });

  it("refuses a bad recipient without calling the provider", async () => {
    const f = vi.fn();
    await expect(
      sendEmail(cfg, { ...msg, to: "nope" }, f as unknown as typeof fetch)
    ).rejects.toThrow(/not a valid email/);
    expect(f).not.toHaveBeenCalled();
  });

  it("reports a refusal and never leaks the key", async () => {
    const f = vi.fn(
      async () =>
        new Response(JSON.stringify({ message: `bad key ${cfg.apiKey}` }), { status: 401 })
    );
    const err = await sendEmail(cfg, msg, f as unknown as typeof fetch).then(
      () => new Error("did not throw"),
      (e: Error) => e
    );
    expect(err.message).toMatch(/HTTP 401/);
    expect(err.message).not.toContain(cfg.apiKey);
  });

  it("copes with a non-JSON error body", async () => {
    const f = vi.fn(async () => new Response("<html>", { status: 502 }));
    await expect(sendEmail(cfg, msg, f as unknown as typeof fetch)).rejects.toThrow(/HTTP 502\)\./);
  });

  it("turns a network failure into a plain message without the key", async () => {
    const f = vi.fn(async () => {
      throw new TypeError(`fetch failed ${cfg.apiKey}`);
    });
    const err = await sendEmail(cfg, msg, f as unknown as typeof fetch).then(
      () => new Error("did not throw"),
      (e: Error) => e
    );
    expect(err.message).toMatch(/Could not reach/);
    expect(err.message).not.toContain(cfg.apiKey);
  });
});
