// El Salvador is UTC-6 all year (no daylight saving since 1988).
export const SV_OFFSET_MS = -6 * 60 * 60 * 1000;
export const DAY_MS = 24 * 60 * 60 * 1000;

/** Local El Salvador date and time for a moment (default: now). */
export function svNow(nowMs: number = Date.now()): { fecha: string; hora: string } {
  const iso = new Date(nowMs + SV_OFFSET_MS).toISOString();
  return { fecha: iso.slice(0, 10), hora: iso.slice(11, 16) };
}

export function isValidFecha(f: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f)) return false;
  const d = new Date(f + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === f;
}

export const MIN_FECHA = "2000-01-01";

/** A valid date between 2000-01-01 and tomorrow in El Salvador. */
export function isAllowedFecha(f: string, nowMs: number = Date.now()): boolean {
  return isValidFecha(f) && f >= MIN_FECHA && f <= shiftDays(svNow(nowMs).fecha, 1);
}

export function isValidMonth(m: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(m);
}

/** "2026-11-25", 3 -> "2026-11-28" */
export function shiftDays(fecha: string, days: number): string {
  return new Date(Date.parse(fecha + "T00:00:00Z") + days * DAY_MS).toISOString().slice(0, 10);
}

/** First day, last day and number of days of a "YYYY-MM" month. */
export function monthBounds(month: string): { start: string; end: string; days: number } {
  const [y, m] = month.split("-").map(Number);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { start: `${month}-01`, end: `${month}-${String(days).padStart(2, "0")}`, days };
}
