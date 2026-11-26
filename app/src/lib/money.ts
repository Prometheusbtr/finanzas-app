// Money is always whole cents (integers). Never floats.

export const MAX_CENTS = 10_000_000; // $100,000: anything bigger is a typing mistake

/**
 * Parse a typed or bank amount like "12", "12.5", "$1,234.56" or "3,50" into cents.
 * Returns null when the text is not a clean positive amount with at most 2 decimals.
 */
export function parseCents(input: string | number): number | null {
  let s = String(input).trim().replace(/^\$|^US\$|USD\s*/i, "").replace(/\s/g, "");
  if (s === "") return null;
  if (/^\d+,\d{1,2}$/.test(s)) s = s.replace(",", "."); // decimal comma from a Spanish keyboard
  else if (/^\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(s)) s = s.replace(/,/g, ""); // thousands commas
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  const cents = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  if (!Number.isSafeInteger(cents) || cents > MAX_CENTS) return null;
  return cents;
}

/** 123456 -> "1,234.56" (no currency sign). */
export function centsToText(cents: number): string {
  const neg = cents < 0;
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return (neg ? "-" : "") + whole + "." + String(abs % 100).padStart(2, "0");
}

/** 123456 -> "1234.56" (for CSV, no grouping). */
export function centsToPlain(cents: number): string {
  const neg = cents < 0;
  const abs = Math.abs(cents);
  return (neg ? "-" : "") + Math.floor(abs / 100) + "." + String(abs % 100).padStart(2, "0");
}
