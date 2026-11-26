// "Primeros pasos" math, pure: which months count for averages, and how a picked limit is rounded.

/** Months ("YYYY-MM") fully covered by data from `firstFecha` up to `today`, newest last, at most `max`.
 * A month counts only if the data starts on or before its first day and the month is over. */
export function fullMonths(firstFecha: string | null, today: string, max = 3): string[] {
  if (!firstFecha) return [];
  const out: string[] = [];
  let [y, m] = today.slice(0, 7).split("-").map(Number);
  for (;;) {
    m -= 1;
    if (m === 0) {
      m = 12;
      y -= 1;
    }
    const ym = `${y}-${String(m).padStart(2, "0")}`;
    if (`${ym}-01` < firstFecha || out.length >= max) break;
    out.unshift(ym);
  }
  return out;
}

/** Round to the nearest $5 (500 cents), never below 0. */
export function roundTo5(cents: number): number {
  return Math.max(0, Math.round(cents / 500) * 500);
}

/** The limit choices offered for one group: the average as it is, 10% less and 20% less, all rounded to $5. */
export function limitChoices(avgCents: number): { same: number; less10: number; less20: number } {
  return { same: roundTo5(avgCents), less10: roundTo5(avgCents * 0.9), less20: roundTo5(avgCents * 0.8) };
}
