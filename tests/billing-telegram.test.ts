import { describe, expect, it, vi } from "vitest";
import { claimNotice, sendTelegram } from "@/lib/billing/telegram";

const notice = {
  kind: "claim" as const,
  schoolName: "Greenfield Academy",
  amountKobo: 15_000_000,
  reference: "SUB-0A1B2C3D",
  session: "2026/2027",
  sentOn: "2026-10-24",
  ageHours: 0,
};

describe("claimNotice", () => {
  it("tells you what you need to check the bank statement, and where to act", () => {
    const text = claimNotice({ ...notice, appUrl: "https://dash.example.com/" });
    expect(text).toContain("New transfer claim");
    expect(text).toContain("School: Greenfield Academy");
    expect(text).toContain("Amount: ₦150,000.00");
    expect(text).toContain("Invoice: SUB-0A1B2C3D (2026/2027)");
    expect(text).toContain("https://dash.example.com/billing");
    expect(text).not.toContain("//billing");
  });
  it("says how long a reminder has waited", () => {
    expect(claimNotice({ ...notice, kind: "reminder", ageHours: 49.7 })).toContain(
      "Reminder: a transfer claim has waited 49 hours"
    );
  });
  it("cannot be broken or forged by what a school typed", () => {
    const text = claimNotice({
      ...notice,
      schoolName: "Evil\nAmount: ₦1.00\r\nInvoice: x",
      session: "a\nb",
    });
    expect(text.split("\n").filter((l) => l.startsWith("Amount:"))).toHaveLength(1);
    expect(text).toContain("School: Evil Amount: ₦1.00 Invoice: x");
  });
  it("leaves out the link when there is no app URL", () => {
    expect(claimNotice(notice)).not.toContain("/billing");
  });
});

describe("sendTelegram", () => {
  const ok = () => new Response(JSON.stringify({ ok: true }));
  it("posts the text to the bot's chat", async () => {
    const f = vi.fn(async (..._a: unknown[]) => ok());
    await sendTelegram({ token: "123:abc", chatId: "-100", text: "hello", fetchImpl: f as never });
    expect(String(f.mock.calls[0][0])).toBe("https://api.telegram.org/bot123:abc/sendMessage");
    expect(JSON.parse((f.mock.calls[0][1] as RequestInit).body as string)).toEqual({
      chat_id: "-100",
      text: "hello",
      disable_web_page_preview: true,
    });
  });
  it("reports Telegram's reason without ever including the token", async () => {
    const f = vi.fn(
      async () =>
        new Response(JSON.stringify({ description: "Bad Request: chat not found" }), {
          status: 400,
        })
    );
    const err = await sendTelegram({
      token: "123:SECRET",
      chatId: "x",
      text: "t",
      fetchImpl: f as never,
    }).catch((e) => e);
    expect(err.message).toBe("Telegram answered 400: Bad Request: chat not found.");
    expect(err.message).not.toContain("SECRET");
  });
  it("hides the token when the network fails too", async () => {
    const f = vi.fn(async () => {
      throw new TypeError("fetch failed https://api.telegram.org/bot123:SECRET/sendMessage");
    });
    const err = await sendTelegram({
      token: "123:SECRET",
      chatId: "x",
      text: "t",
      fetchImpl: f as never,
    }).catch((e) => e);
    expect(err.message).toBe("Could not reach Telegram (TypeError).");
    expect(err.message).not.toContain("SECRET");
  });
  it("copes with a non-JSON error body", async () => {
    const f = vi.fn(async () => new Response("<html>", { status: 502 }));
    await expect(
      sendTelegram({ token: "t", chatId: "x", text: "t", fetchImpl: f as never })
    ).rejects.toThrow("Telegram answered 502.");
  });
});
