// Reading the amounts and rates she types. No imports and no page access, so the tests can load it as it is.

/** Cents from what she typed, or null. opts.max: the largest amount (default $100,000, the USD cap; another currency's
 * amount allows up to 1e14). opts.zero: 0 is a valid answer (a paid-off card's minimum payment). */
export function parseCents(input, opts = {}) {
  const max = opts.max ?? 10000000;
  let s = String(input).trim().replace(/^\$/, "").replace(/\s/g, "");
  if (!s) return null;
  if (opts.zero && isZero(s)) return 0;
  if (/^\d+,\d{1,2}$/.test(s)) s = s.replace(",", ".");
  else if (/^\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(s)) s = s.replace(/,/g, "");
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  const cents = Number(m[1]) * 100 + Number((m[2] || "").padEnd(2, "0"));
  return cents > 0 && cents <= max ? cents : null;
}
/** "0", "0.00", "0,0": the shapes a zero amount comes in (centsToInput(0) gives "0.00"). */
export const isZero = (s) => /^\$?0+([.,]0{1,2})?$/.test(String(s).trim());

/** Currencies whose rate is in the thousands per dollar: there "4.400" is a Colombian thousands dot, not 4.4, so a dot
 * followed by exactly 3 digits is asked about instead of guessed. Only COP (about 4,000). CRC is about 500 a dollar,
 * so "512.500" is 512.5 and a thousands mark never appears in its rate. */
const BIG_RATE = new Set(["COP"]);

/**
 * The rate she typed, as a number, or an error key. "4,400" and "1,234.5" use commas for thousands; "1,25" and
 * "0,92" use a decimal comma. Anything else with a comma is refused, never guessed.
 * One comma with exactly 3 digits after it ("1,385") is both: thousands only for COP (whose rate is in the
 * thousands), refused for the rest. A leading 0 ("0,925") is always a decimal comma.
 */
export function parseRate(input, currency) {
  let s = String(input).trim().replace(/\s/g, "");
  if (!s) return { rate: null };
  if (/^\d{1,3},\d{3}$/.test(s) && !/^0,/.test(s) && !BIG_RATE.has(currency)) return { error: "fnFxBadRate" };
  if (/^[1-9]\d{0,2}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, "");
  else if (/^\d+,\d+$/.test(s)) s = s.replace(",", ".");
  if (!/^\d+(\.\d+)?$/.test(s)) return { error: "fnFxBadRate" };
  if (BIG_RATE.has(currency) && /^\d{1,3}\.\d{3}$/.test(s)) return { error: "fnFxRateDot", x: s.replace(".", "") };
  const rate = Number(s);
  return rate > 0 && Number.isFinite(rate) ? { rate } : { error: "fnFxNeedRate" };
}
