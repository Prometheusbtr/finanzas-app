// Statement rows into movements. The server decides everything that matters: the tipo, the dedupe key
// (with an occurrence index, because two equal purchases on one day are real), and whether the row is
// already in the app from any source (typed, BAC email, seed rows, an earlier import).
//
// Rule for "already there" (same as merge.ts): same account, same amount, within 3 days, and a compatible
// direction. Each existing row is claimed at most once per import. A bank-side row (email, seed, earlier
// import) means "ya estaba": nothing is written. A row from an earlier statement or file only counts on the
// same date (statement dates never drift, so a $2.50 coffee the next day is a new coffee). One typed gasto:
// the new bank row is saved with the typed row's details and the typed row goes. More than one typed gasto:
// saved as "revisar" with merge suggestions. A typed transfer, refund or ignored row is the record itself.
//
// One chunk is written in ONE batch (a D1 transaction): rows, merges and suggestions all land or none do.

import type { MovementRow, Tipo } from "../types.ts";
import { shiftDays } from "./dates.ts";
import { MERGE_WINDOW_DAYS, mergedRate, parseTags, prevRows } from "./merge.ts";
import { merchantKey } from "./merchant.ts";
import { starterCategory } from "./rules.ts";
import { cleanText } from "./text.ts";

export type ImportSource = "bac_tc" | "agricola_tc" | "uglycash" | "csv";
export type InRow = { fecha: string; comercio?: string; cents: number; dir: "out" | "in"; tipo?: "interno" | "ingreso" | null };
export type ImportRec = { id: number; account_id: number; source: ImportSource; period_start: string; period_end: string };
export type Counts = { added: number; already: number; merged: number; review: number };

type Existing = { id: number; fecha: string; tipo: Tipo; origen: string; dedupe_key: string; amount_cents: number };

/** Card statements: the only sources whose money in is a refund (SECURITY.md: only a card's credits are refunds). */
export const isCard = (source: ImportSource) => source === "bac_tc" || source === "agricola_tc";

/**
 * The tipo the server gives a row: only "interno" and "ingreso" may come from the phone; the rest follows the
 * direction. Money in on a card statement is a refund (abono, which lowers spending). Anywhere else (a wallet, a
 * general CSV) money in is mostly pay or a transfer from someone: it is ingreso, so it never lowers spending, and
 * it waits in Revisar (askIn) until the user says what it is ("Es reembolso" makes it abono there).
 */
export function tipoOf(r: InRow, source: ImportSource): Tipo {
  if (r.tipo === "interno") return "interno";
  if (r.dir === "in") return r.tipo === "ingreso" || !isCard(source) ? "ingreso" : "abono";
  return "gasto";
}
/** Money in outside a card statement that the file did not name: saved as ingreso and sent to Revisar. */
export const askIn = (r: InRow, source: ImportSource) => !isCard(source) && r.dir === "in" && r.tipo !== "ingreso" && r.tipo !== "interno";

/** Rows that came from a statement or a file (seed rows from statements too): their dates are the bank's own. */
export const fromFile = (origen: string) => origen.startsWith("estado") || origen === "CSV" || origen === "archivo CSV";

/**
 * Long digit runs (card, account and reference numbers) keep only their last 4, as the phone already does
 * (public/import/parse.js maskDigits, same rules). Done again here, so a number the phone missed is never stored.
 */
export function maskDigits(s: string): string {
  return s
    .replace(/\b\d{4}(?:[ -]\d{4}){2,3}\b/g, (m) => "••••" + m.replace(/\D/g, "").slice(-4))
    .replace(/\d(?:-?\d){6,}/g, (m) => "••••" + m.replace(/\D/g, "").slice(-4))
    .replace(/\d(?:[ -]?\d){11,}/g, (m) => "••••" + m.replace(/\D/g, "").slice(-4));
}
/** A shop name from a statement as the server keeps it: no invisible characters, numbers masked, at most 120. */
export const cleanShop = (s: string | undefined) => maskDigits(cleanText(s ?? "")).slice(0, 120);

const OUT: Tipo[] = ["gasto", "interno", "ignorado"];
const IN: Tipo[] = ["abono", "ingreso", "interno", "ignorado"];
/** Can an existing row of tipo `t` be the same money as a new row going `dir`? Rechazado never is. */
export function compatible(dir: "out" | "in", t: Tipo): boolean {
  return (dir === "out" ? OUT : IN).includes(t);
}

export const baseOf = (accountId: number, fecha: string, tipo: Tipo, cents: number) => `${accountId}|${fecha}|${tipo}|${cents}`;
export const keyOf = (base: string, n: number) => `imp:${base.replace(/\|/g, ":")}:${n}`;

/** Sort order the phone uses for chunks, so equal rows (one "base") are always next to each other. */
export function sortRows<T extends InRow>(rows: T[]): T[] {
  return [...rows].sort(
    (a, b) => a.fecha.localeCompare(b.fecha) || a.dir.localeCompare(b.dir) || String(a.tipo ?? "").localeCompare(String(b.tipo ?? "")) || a.cents - b.cents,
  );
}

type Planned = {
  row: InRow;
  tipo: Tipo;
  base: string;
  key: string;
  outcome: "already" | "added" | "merged" | "review";
  claim: number | null; // the existing row claimed (already) or the typed row merged (merged)
  candidates: number[]; // typed rows when more than one could be the same purchase
};

const dayDiff = (a: string, b: string) => Math.abs(Date.parse(a + "T00:00:00Z") - Date.parse(b + "T00:00:00Z")) / 86_400_000;

/**
 * Decide each row's fate without writing anything. `existing` holds the account's rows in the window,
 * `claimed` the ids already used by this import (it is updated), `seen` the count of each base already in
 * this import (for the occurrence index).
 */
export function planRows(
  accountId: number, source: ImportSource, rows: InRow[], existing: Existing[], claimed: Set<number>, seen: Map<string, number>,
): Planned[] {
  const byKey = new Map(existing.map((e) => [e.dedupe_key, e]));
  const local = new Map<string, number>();
  const plans: Planned[] = rows.map((row) => {
    const tipo = tipoOf(row, source);
    const base = baseOf(accountId, row.fecha, tipo, row.cents);
    const n = (seen.get(base) ?? 0) + (local.get(base) ?? 0) + 1;
    local.set(base, (local.get(base) ?? 0) + 1);
    return { row, tipo, base, key: keyOf(base, n), outcome: "added", claim: null, candidates: [] };
  });
  // 1. The same file (or an overlapping one) imported before: the exact key is there.
  for (const p of plans) {
    const hit = byKey.get(p.key);
    if (hit && !claimed.has(hit.id)) {
      p.outcome = "already";
      p.claim = hit.id;
      claimed.add(hit.id);
    } else if (hit) {
      p.outcome = "already"; // the key exists and is already used by this import: never insert twice
    }
  }
  // 2. The same money from another source within 3 days.
  for (const p of plans) {
    if (p.outcome !== "added") continue;
    const near = existing.filter(
      (e) => !claimed.has(e.id) && e.amount_cents === p.row.cents && compatible(p.row.dir, e.tipo) && dayDiff(e.fecha, p.row.fecha) <= MERGE_WINDOW_DAYS,
    );
    const rank = (e: Existing) => [dayDiff(e.fecha, p.row.fecha), e.tipo === p.tipo ? 0 : 1, e.id];
    const best = (list: Existing[]) =>
      [...list].sort((a, b) => {
        const x = rank(a);
        const y = rank(b);
        return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
      })[0];
    // F01: a row from an earlier statement or file is the same money only on the same date.
    const bank = near.filter((e) => e.origen !== "manual" && (!fromFile(e.origen) || e.fecha === p.row.fecha));
    const manual = near.filter((e) => e.origen === "manual");
    // F10: only a typed gasto merges into the bank row. A typed transfer, refund or ignored row is the record.
    const typedSpend = p.tipo === "gasto" ? manual.filter((e) => e.tipo === "gasto") : [];
    if (bank.length) {
      const e = best(bank);
      p.outcome = "already";
      p.claim = e.id;
      claimed.add(e.id);
    } else if (typedSpend.length === 1) {
      p.outcome = "merged";
      p.claim = typedSpend[0].id;
      claimed.add(typedSpend[0].id);
    } else if (typedSpend.length > 1) {
      p.outcome = "review";
      p.candidates = typedSpend.map((m) => m.id);
    } else if (manual.length) {
      // a typed refund, transfer or ignored row: the typed row is the record, nothing to add
      const e = best(manual);
      p.outcome = "already";
      p.claim = e.id;
      claimed.add(e.id);
    }
  }
  return plans;
}

export async function loadExisting(db: D1Database, userId: number, accountId: number, rows: InRow[]): Promise<Existing[]> {
  if (!rows.length) return [];
  const ds = rows.map((r) => r.fecha).sort();
  const { results } = await db
    .prepare(
      `SELECT id, fecha, tipo, origen, dedupe_key, amount_cents FROM movements
       WHERE user_id = ? AND account_id = ? AND fecha BETWEEN ? AND ? AND tipo <> 'rechazado'`,
    )
    .bind(userId, accountId, shiftDays(ds[0], -MERGE_WINDOW_DAYS), shiftDays(ds[ds.length - 1], MERGE_WINDOW_DAYS))
    .all<Existing>();
  return results;
}

export async function loadClaims(db: D1Database, userId: number, importId: number) {
  const [claims, bases] = await db.batch([
    db.prepare("SELECT movement_id FROM import_rows WHERE user_id = ? AND import_id = ? AND movement_id IS NOT NULL").bind(userId, importId),
    db.prepare("SELECT base, COUNT(*) AS n FROM import_rows WHERE user_id = ? AND import_id = ? GROUP BY base").bind(userId, importId),
  ]);
  return {
    claimed: new Set((claims.results as { movement_id: number }[]).map((r) => r.movement_id)),
    seen: new Map((bases.results as { base: string; n: number }[]).map((r) => [r.base, r.n])),
  };
}

/** Category for a new row: the user's own shop memory, then a starter rule whose category the user still has. */
async function categorizer(db: D1Database, userId: number) {
  const [rules, cats] = await db.batch([
    db.prepare(
      `SELECT r.merchant_key, r.category_id FROM merchant_rules r JOIN categories c ON c.id = r.category_id
       WHERE r.user_id = ? AND c.user_id = r.user_id AND c.archived = 0`,
    ).bind(userId),
    db.prepare("SELECT id, name FROM categories WHERE user_id = ? AND archived = 0").bind(userId),
  ]);
  const memory = new Map((rules.results as { merchant_key: string; category_id: number }[]).map((r) => [r.merchant_key, r.category_id]));
  const byName = new Map((cats.results as { id: number; name: string }[]).map((c) => [c.name, c.id]));
  return (key: string, comercio: string): number | null => {
    const own = key ? memory.get(key) : undefined;
    if (own) return own;
    const starter = starterCategory(comercio);
    return starter ? byName.get(starter) ?? null : null;
  };
}

export const ORIGEN: Record<ImportSource, string> = {
  bac_tc: "estado de cuenta", agricola_tc: "estado de cuenta", uglycash: "estado de cuenta", csv: "archivo CSV",
};

/** The typed rows a chunk merges, read whole (undo puts them back from this copy). */
async function loadTyped(db: D1Database, userId: number, ids: number[]): Promise<Map<number, MovementRow>> {
  const out = new Map<number, MovementRow>();
  for (let i = 0; i < ids.length; i += 90) {
    const part = ids.slice(i, i + 90);
    const { results } = await db.prepare(`SELECT * FROM movements WHERE user_id = ? AND origen = 'manual' AND id IN (${part.map(() => "?").join(",")})`)
      .bind(userId, ...part).all<MovementRow>();
    for (const r of results) out.set(r.id, r);
  }
  return out;
}

/**
 * Save one chunk of an import, in ONE batch (a D1 transaction): the new rows, their import_rows, the merges of
 * typed rows and the Revisar suggestions all land together, or nothing does and the part can be sent again.
 * A merged row is written already merged: the typed row's category, note, tags and other-currency amount go
 * on the new bank row, its Personas lines move there, and the typed row is kept whole on this import's row
 * (prev) in the same write that deletes it, so undo brings it back.
 */
export async function saveChunk(db: D1Database, userId: number, imp: ImportRec, rows: InRow[], part: number): Promise<Counts> {
  const [existing, { claimed, seen }, categoryFor] = await Promise.all([
    loadExisting(db, userId, imp.account_id, rows),
    loadClaims(db, userId, imp.id),
    categorizer(db, userId),
  ]);
  const plans = planRows(imp.account_id, imp.source, rows, existing, claimed, seen);
  const typed = await loadTyped(db, userId, plans.filter((p) => p.outcome === "merged" && p.claim != null).map((p) => p.claim!));
  const now = Date.now();
  const counts: Counts = { added: 0, already: 0, merged: 0, review: 0 };
  // The part is claimed inside the same transaction: when this part number is taken (a copy sent at the same time,
  // or a save whose answer was lost) or the import is no longer open (undone meanwhile), parts would be NULL, the
  // NOT NULL rule refuses it and the whole part rolls back. So "parts" always counts exactly the parts written.
  const stmts: D1PreparedStatement[] = [
    db.prepare("UPDATE imports SET parts = CASE WHEN parts = ? AND status = 'open' THEN parts + 1 END, updated_at = ? WHERE id = ? AND user_id = ?")
      .bind(part, now, imp.id, userId),
  ];
  for (const p of plans) {
    if (p.outcome === "already") {
      counts.already++;
      stmts.push(
        db.prepare(`INSERT INTO import_rows (import_id, user_id, movement_id, kind, base, created_at) VALUES (?, ?, ?, 'already', ?, ?)`)
          .bind(imp.id, userId, p.claim, p.base, now),
      );
      continue;
    }
    const comercio = cleanShop(p.row.comercio);
    const key = merchantKey(comercio);
    const sorts = p.tipo === "gasto" || p.tipo === "abono";
    const manual = p.outcome === "merged" && p.claim != null ? typed.get(p.claim) : undefined;
    const category = manual?.category_id ?? (sorts ? categoryFor(key, comercio) : null);
    const estado = p.outcome === "review" || (sorts && !category) || askIn(p.row, imp.source) ? "revisar" : "ok";
    // raw names this import, so it is also the proof that a row was written by this chunk (see below).
    const raw = JSON.stringify({ import_id: imp.id, source: imp.source, fecha: p.row.fecha, comercio, cents: p.row.cents, dir: p.row.dir });
    const fx = manual?.orig_currency ? [manual.orig_currency, manual.orig_cents, mergedRate(manual, p.row.cents)] : [null, null, null];
    stmts.push(
      db.prepare(
        `INSERT INTO movements (user_id, fecha, hora, amount_cents, tipo, comercio, merchant_key, account_id, category_id,
           tags, nota, origen, estado, raw, dedupe_key, orig_currency, orig_cents, fx_micros, created_at, updated_at)
         VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (user_id, dedupe_key) DO NOTHING`,
      ).bind(userId, p.row.fecha, p.row.cents, p.tipo, comercio, key, imp.account_id, category,
        manual ? JSON.stringify([...new Set(parseTags(manual.tags))]) : "[]", manual?.nota ?? "",
        ORIGEN[imp.source], estado, raw, p.key, ...fx, now, now),
      // The key can already be taken by a row outside the window read above (moved to another account or date,
      // or rechazado): then nothing was inserted, and that row is only claimed, so undo never deletes it.
      db.prepare(
        `INSERT INTO import_rows (import_id, user_id, movement_id, kind, base, prev, created_at)
         SELECT ?, ?, id, CASE WHEN raw IS ? THEN ? ELSE 'already' END, ?, CASE WHEN raw IS ? THEN ? END, ? FROM movements
         WHERE user_id = ? AND dedupe_key = ?`,
      ).bind(imp.id, userId, raw, manual ? "merged" : "added", p.base, raw, manual ? JSON.stringify([manual]) : null, now, userId, p.key),
    );
    // "This chunk wrote the row": every follow-up below only acts when it did.
    const mine = `EXISTS (SELECT 1 FROM movements WHERE user_id = ? AND dedupe_key = ? AND raw IS ?)`;
    const bankId = `(SELECT id FROM movements WHERE user_id = ? AND dedupe_key = ? AND raw IS ?)`;
    if (manual) {
      stmts.push(
        db.prepare(`UPDATE OR IGNORE person_entries SET movement_id = ${bankId} WHERE user_id = ? AND movement_id = ? AND ${mine}`)
          .bind(userId, p.key, raw, userId, manual.id, userId, p.key, raw),
        db.prepare(`DELETE FROM merge_suggestions WHERE user_id = ? AND manual_id = ? AND ${mine}`).bind(userId, manual.id, userId, p.key, raw),
        db.prepare(`DELETE FROM movements WHERE id = ? AND user_id = ? AND origen = 'manual' AND ${mine}`).bind(manual.id, userId, userId, p.key, raw),
      );
      // The shop is learned only when the merge happened (as before: no merge on a key collision, no rule).
      if (manual.category_id && key) {
        stmts.push(
          db.prepare(
            `INSERT INTO merchant_rules (user_id, merchant_key, category_id, updated_at) SELECT ?, ?, ?, ? WHERE ${mine}
             ON CONFLICT (user_id, merchant_key) DO UPDATE SET category_id = excluded.category_id, updated_at = excluded.updated_at`,
          ).bind(userId, key, manual.category_id, now, userId, p.key, raw),
        );
      }
      counts.merged++;
      continue;
    }
    for (const c of p.outcome === "review" ? p.candidates : []) {
      stmts.push(
        db.prepare(
          `INSERT OR IGNORE INTO merge_suggestions (user_id, bank_id, manual_id, created_at)
           SELECT ?, id, ?, ? FROM movements WHERE user_id = ? AND dedupe_key = ? AND raw IS ?`,
        ).bind(userId, c, now, userId, p.key, raw),
      );
    }
    counts.added++;
    if (estado === "revisar") counts.review++;
  }
  await db.batch(stmts);
  return counts;
}

/** Recount an import from its rows (the review count follows the rows as they are now) and store it. */
export async function refreshTotals(db: D1Database, userId: number, importId: number): Promise<Counts> {
  const r = await db
    .prepare(
      `SELECT SUM(ir.kind = 'added') AS added, SUM(ir.kind = 'already') AS already, SUM(ir.kind = 'merged') AS merged,
         SUM(ir.kind = 'added' AND m.estado = 'revisar') AS review
       FROM import_rows ir LEFT JOIN movements m ON m.id = ir.movement_id AND m.user_id = ir.user_id
       WHERE ir.user_id = ? AND ir.import_id = ?`,
    )
    .bind(userId, importId)
    .first<Record<keyof Counts, number | null>>();
  const c: Counts = { added: r?.added ?? 0, already: r?.already ?? 0, merged: r?.merged ?? 0, review: r?.review ?? 0 };
  await db.prepare("UPDATE imports SET added = ?, already = ?, merged = ?, review = ?, updated_at = ? WHERE id = ? AND user_id = ?")
    .bind(c.added, c.already, c.merged, c.review, Date.now(), importId, userId).run();
  return c;
}

/** The same decision as saveChunk, without writing. Claims are only known inside this call. */
export async function previewChunk(db: D1Database, userId: number, accountId: number, source: ImportSource, rows: InRow[]): Promise<Counts> {
  const [existing, categoryFor] = await Promise.all([loadExisting(db, userId, accountId, rows), categorizer(db, userId)]);
  const plans = planRows(accountId, source, rows, existing, new Set(), new Map());
  const counts: Counts = { added: 0, already: 0, merged: 0, review: 0 };
  for (const p of plans) {
    if (p.outcome === "already") counts.already++;
    else if (p.outcome === "merged") counts.merged++;
    else {
      counts.added++;
      const comercio = cleanShop(p.row.comercio);
      const sorts = p.tipo === "gasto" || p.tipo === "abono";
      if (p.outcome === "review" || (sorts && !categoryFor(merchantKey(comercio), comercio)) || askIn(p.row, source)) counts.review++;
    }
  }
  return counts;
}

/**
 * Undo a whole import: remove the rows it added and bring back the typed rows merged into them (by the import
 * itself or later, in Revisar). A typed row comes back with every column the movements table has now, read from
 * the table itself, so columns added by later migrations (accounts, currencies) come back too, not as defaults.
 *
 * F03: a row that a newer import (not undone) also counted as "ya estaba" is not deleted: it is handed over to
 * that import, which now owns it as added (or merged, with the typed copy), so undoing that one removes it later.
 */
export async function undoImport(db: D1Database, userId: number, importId: number): Promise<{ removed: number; restored: number; kept: number }> {
  const [rows, info, heirs] = await db.batch([
    db.prepare("SELECT movement_id, kind, prev FROM import_rows WHERE user_id = ? AND import_id = ? AND kind IN ('added', 'merged')")
      .bind(userId, importId),
    db.prepare("PRAGMA table_info(movements)"), // allowed in D1 (its docs list table_info)
    db.prepare(
      `SELECT o.movement_id, MAX(o.id) AS heir, o.import_id FROM import_rows o JOIN imports i ON i.id = o.import_id AND i.user_id = o.user_id
       WHERE o.user_id = ? AND o.import_id <> ? AND o.kind = 'already' AND i.status <> 'undone'
         AND o.movement_id IN (SELECT movement_id FROM import_rows WHERE user_id = ? AND import_id = ? AND kind IN ('added', 'merged'))
       GROUP BY o.movement_id`,
    ).bind(userId, importId, userId, importId),
  ]);
  // (SQLite: with one MAX(), the bare import_id comes from the same row as the MAX.)
  const heirList = heirs.results as { movement_id: number; heir: number; import_id: number }[];
  const heirOf = new Map(heirList.map((h) => [h.movement_id, h.heir]));
  const results = rows.results as { movement_id: number | null; kind: string; prev: string | null }[];
  // Column names come from the schema, never from the stored JSON. user_id is always this user.
  const cols = (info.results as { name: string }[]).map((c) => c.name).filter((n) => /^[a-z_][a-z0-9_]*$/.test(n));
  if (!cols.includes("id") || !cols.includes("user_id")) throw new Error("movements columns not readable");
  const stmts: D1PreparedStatement[] = [];
  let removed = 0;
  let kept = 0;
  const restores: number[] = []; // positions of the restoring statements in the batch
  for (const r of results) {
    const heir = r.movement_id != null ? heirOf.get(r.movement_id) : undefined;
    if (heir != null) {
      stmts.push(db.prepare("UPDATE import_rows SET kind = ?, prev = ? WHERE id = ? AND user_id = ?").bind(r.kind, r.prev, heir, userId));
      kept++;
      continue;
    }
    // Typed rows come back first, so the Personas lines on the bank row (moved there by the merge) can go back to
    // the typed row before the bank row is deleted; otherwise they would stay, with their amounts, linked to nothing.
    let relinkKey: string | null = null;
    for (const m of r.kind === "merged" ? prevRows(r.prev) : []) {
      if (m.user_id !== userId) continue;
      const have = cols.filter((k) => k in m);
      if (!have.includes("id")) continue;
      restores.push(stmts.length);
      // Its old id, unless a newer row took it meanwhile (SQLite hands a freed highest id to the next row): then a
      // new id. OR IGNORE only skips a row that is back already (same dedupe_key).
      const vals = have.map((k) => (k === "id" ? "(CASE WHEN EXISTS (SELECT 1 FROM movements WHERE id = ?) THEN NULL ELSE ? END)" : "?"));
      const binds = have.flatMap((k) => (k === "id" ? [m.id, m.id] : [k === "user_id" ? userId : (m[k] ?? null)])) as (string | number | null)[];
      stmts.push(db.prepare(`INSERT OR IGNORE INTO movements (${have.join(", ")}) SELECT ${vals.join(", ")}`).bind(...binds));
      if (typeof m.dedupe_key === "string") relinkKey = m.dedupe_key;
    }
    if (r.movement_id != null) {
      if (relinkKey) {
        stmts.push(db.prepare(
          `UPDATE OR IGNORE person_entries SET movement_id = (SELECT id FROM movements WHERE user_id = ? AND dedupe_key = ?)
           WHERE user_id = ? AND movement_id = ? AND EXISTS (SELECT 1 FROM movements WHERE user_id = ? AND dedupe_key = ?)`,
        ).bind(userId, relinkKey, userId, r.movement_id, userId, relinkKey));
      }
      stmts.push(db.prepare("DELETE FROM movements WHERE id = ? AND user_id = ?").bind(r.movement_id, userId));
      removed++;
    }
  }
  stmts.push(db.prepare("UPDATE imports SET status = 'undone', updated_at = ? WHERE id = ? AND user_id = ?").bind(Date.now(), importId, userId));
  const out = await db.batch(stmts);
  const restored = restores.reduce((n, i) => n + (out[i].meta.changes ? 1 : 0), 0);
  // The imports that took rows over now own them as added or merged: their counts in the history follow.
  for (const heirImport of new Set(heirList.map((h) => h.import_id))) await refreshTotals(db, userId, heirImport);
  return { removed, restored, kept };
}
