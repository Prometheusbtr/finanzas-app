// Checks for scripts/seed.ts (F48): a ledger row goes in only with the same shapes the app and the database accept,
// so a bad row is counted as skipped instead of being dropped silently by the database.
import { isValidFecha } from "./dates.ts";
import { TIPOS, type Tipo } from "../types.ts";

/** "9:05", "09:05" and "09:05:33" become "09:05"; empty is no time; anything else is not readable (undefined). */
export function seedHora(h: string | null | undefined): string | null | undefined {
  if (h == null || h.trim() === "") return null;
  const m = /^(\d{1,2}):([0-5]\d)(?::[0-5]\d)?$/.exec(h.trim());
  if (!m || Number(m[1]) > 23) return undefined;
  return `${m[1]!.padStart(2, "0")}:${m[2]}`;
}

/** The row's date, time and type as the database takes them, or null when one of them is not valid. */
export function seedRowShape(r: { fecha?: string; hora?: string | null; tipo?: string }): { fecha: string; hora: string | null; tipo: Tipo } | null {
  const hora = seedHora(r.hora);
  if (!r.fecha || !isValidFecha(r.fecha) || hora === undefined || !(TIPOS as readonly string[]).includes(r.tipo ?? "")) return null;
  return { fecha: r.fecha, hora, tipo: r.tipo as Tipo };
}
