import { describe, expect, it } from "vitest";
import {
  isReminderKind,
  reminderEmail,
  reminderOwnerNotice,
  type ReminderInput,
} from "@/lib/billing/reminder";

const base: ReminderInput = {
  kind: "before_14",
  schoolName: "Greenfield Academy",
  contactName: "Mrs Okoye",
  reference: "INV-2026-0007",
  session: "2026/2027",
  amountKobo: 25_000_000,
  licenceEnds: new Date("2026-11-15T00:00:00Z"),
  graceEnds: new Date("2026-11-29T00:00:00Z"),
  hostname: "greenfield.example.ng",
  supportEmail: "help@example.com",
  now: new Date("2026-11-01T00:00:00Z"),
};

describe("isReminderKind", () => {
  it("accepts the four stages only", () => {
    for (const k of ["before_14", "before_3", "grace", "lapsed"])
      expect(isReminderKind(k)).toBe(true);
    for (const k of ["", "before_7", null, 3]) expect(isReminderKind(k)).toBe(false);
  });
});

describe("reminderEmail", () => {
  it("counts the days to the end of the licence", () => {
    const { subject, text } = reminderEmail(base);
    expect(subject).toContain("INV-2026-0007");
    expect(text).toContain("ends on 2026-11-15, in 14 days");
    expect(text).toContain("Dear Mrs Okoye,");
    expect(text).toContain("https://greenfield.example.ng/");
    expect(text).toContain("help@example.com");
  });

  it("says today or tomorrow when the end is a day away, never 'in 1 days'", () => {
    const { text } = reminderEmail({
      ...base,
      kind: "before_3",
      now: new Date("2026-11-14T12:00:00Z"),
    });
    expect(text).toContain("today or tomorrow");
    expect(text).not.toMatch(/in 1 days/);
  });

  it("explains grace and lapse differently", () => {
    const grace = reminderEmail({ ...base, kind: "grace" });
    const lapsed = reminderEmail({ ...base, kind: "lapsed" });
    expect(grace.text).toContain("grace period until 2026-11-29");
    expect(lapsed.text).toContain("now read-only");
    expect(grace.subject).not.toBe(lapsed.subject);
  });

  it("is generic without a hostname or a contact name", () => {
    const { text } = reminderEmail({
      ...base,
      hostname: null,
      contactName: null,
      supportEmail: null,
    });
    expect(text.startsWith("Hello,")).toBe(true);
    expect(text).not.toContain("https://");
    expect(text).not.toContain("Questions?");
  });

  it("flattens line breaks from database values", () => {
    const { subject, text } = reminderEmail({
      ...base,
      schoolName: "Evil\r\nBcc: x@y.z",
      contactName: "A\nB",
    });
    expect(subject).not.toMatch(/[\r\n]/);
    expect(text).not.toMatch(/Evil\r?\nBcc/);
    expect(text).toContain("Dear A B,");
  });
});

describe("reminderOwnerNotice", () => {
  it("says who was emailed", () => {
    const n = reminderOwnerNotice({
      kind: "before_3",
      schoolName: "Greenfield",
      reference: "INV-1",
      sentTo: "a@b.co",
    });
    expect(n).toContain("sent to a@b.co");
    expect(n).toContain("3 days");
  });

  it("says plainly when there was nobody to email", () => {
    const n = reminderOwnerNotice({
      kind: "lapsed",
      schoolName: "G",
      reference: "INV-1",
      sentTo: null,
    });
    expect(n).toContain("No billing contact email");
    expect(n).toContain("Details");
  });
});
