// Money is whole kobo (1 naira = 100 kobo) everywhere, so no sum is ever off by
// a floating-point fraction. Naira text from a form is parsed with a strict
// pattern, never with parseFloat.

export const MAX_KOBO = 1_000_000_000_000; // N10 billion: far above any school fee, far below 2^53

export class MoneyError extends Error {}

export function nairaToKobo(input: string): number {
  const text = input
    .trim()
    .replace(/^(₦|NGN)\s*/i, "")
    .replace(/,/g, "");
  const m = /^(\d{1,11})(?:\.(\d{1,2}))?$/.exec(text);
  if (!m) throw new MoneyError("Enter an amount in naira, like 150000 or 150,000.50.");
  const kobo = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0") || 0);
  if (kobo > MAX_KOBO) throw new MoneyError("That amount is too large.");
  return kobo;
}

export function formatNaira(kobo: number): string {
  const sign = kobo < 0 ? "-" : "";
  const abs = Math.abs(Math.trunc(kobo));
  const whole = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}₦${whole}.${String(abs % 100).padStart(2, "0")}`;
}
