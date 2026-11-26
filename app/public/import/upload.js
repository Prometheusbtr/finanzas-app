// Statement rows -> what the server takes, in chunks. Pure, shared by the screen and the local checks.
import { maskDigits } from "./parse.js";

export const CHUNK_ROWS = 500;
export const CHUNK_BYTES = 56 * 1024; // the API refuses bodies over 64 KB (UTF-8 bytes)
const enc = new TextEncoder();

/** The rows the server gets: whole cents and a direction; long digit runs keep only their last 4. */
export function apiRows(st) {
  const out = [];
  for (const r of st.rows) {
    if (!r.cents) continue;
    const row = { fecha: r.fecha, comercio: maskDigits(r.comercio || "").slice(0, 120), cents: Math.abs(r.cents), dir: r.cents > 0 ? "out" : "in" };
    if (r.tipo === "interno" || (r.tipo === "ingreso" && r.cents < 0)) row.tipo = r.tipo;
    out.push(row);
  }
  // Same order as the server (src/lib/importing.ts sortRows): equal rows sit together.
  return out.sort((a, b) => a.fecha.localeCompare(b.fecha) || a.dir.localeCompare(b.dir) || String(a.tipo ?? "").localeCompare(String(b.tipo ?? "")) || a.cents - b.cents);
}

const groupKey = (r) => `${r.fecha}|${r.dir}|${r.tipo ?? ""}|${r.cents}`;

/** Split sorted rows into chunks of at most 500 rows and 56 KB, never splitting a group of equal rows. */
export function chunkRows(rows, { maxRows = CHUNK_ROWS, maxBytes = CHUNK_BYTES } = {}) {
  const groups = [];
  for (const r of rows) {
    const last = groups[groups.length - 1];
    if (last && groupKey(last[0]) === groupKey(r)) last.push(r);
    else groups.push([r]);
  }
  const chunks = [];
  let cur = [];
  let bytes = 0;
  for (const g of groups) {
    const gb = g.reduce((s, r) => s + enc.encode(JSON.stringify(r)).length + 1, 0); // bytes, as the server counts
    if (cur.length && (cur.length + g.length > maxRows || bytes + gb > maxBytes)) {
      chunks.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(...g);
    bytes += gb;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

/** Months a statement period touches, for "julio a septiembre". */
export function monthsOf(period) {
  if (!period) return [];
  const out = [];
  let [y, m] = period.start.slice(0, 7).split("-").map(Number);
  const [ey, em] = period.end.slice(0, 7).split("-").map(Number);
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m++;
    if (m === 13) [y, m] = [y + 1, 1];
  }
  return out;
}
