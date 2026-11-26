// A purchase typed by hand and the same purchase arriving later from the bank become one row.
// Rule (plan, Step 2): same account and same amount, within 3 days.
// Exactly one match: merged automatically. More than one: the user is asked in the review inbox.

import { HTTPException } from "hono/http-exception";
import type { MovementRow, Tipo } from "../types.ts";
import { shiftDays } from "./dates.ts";
import { merchantKey } from "./merchant.ts";
import { cleanText } from "./text.ts";
import { getMovement, lookupMerchant, rememberMerchant } from "./owned.ts";

export const MERGE_WINDOW_DAYS = 3;

type MatchInput = { id?: number; account_id: number | null; amount_cents: number; fecha: string };

/** Rows on the other side ("manual" typed rows, or "bank" rows) that could be the same purchase. */
export async function findMatches(
  db: D1Database,
  userId: number,
  m: MatchInput,
  side: "manual" | "bank",
): Promise<MovementRow[]> {
  if (m.account_id == null || m.amount_cents <= 0) return [];
  const origin = side === "manual" ? "origen = 'manual'" : "origen <> 'manual'";
  const { results } = await db
    .prepare(
      `SELECT * FROM movements
       WHERE user_id = ? AND account_id = ? AND amount_cents = ? AND tipo = 'gasto'
         AND fecha BETWEEN ? AND ? AND id <> ? AND ${origin}
       ORDER BY fecha, id`,
    )
    .bind(userId, m.account_id, m.amount_cents, shiftDays(m.fecha, -MERGE_WINDOW_DAYS),
      shiftDays(m.fecha, MERGE_WINDOW_DAYS), m.id ?? 0)
    .all<MovementRow>();
  return results;
}

export function parseTags(t: string): string[] {
  try {
    const v = JSON.parse(t);
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** The typed rows kept on one import row (prev): one row as an object (older), or a list. */
export function prevRows(prev: string | null): Record<string, unknown>[] {
  if (!prev) return [];
  try {
    const v = JSON.parse(prev);
    return (Array.isArray(v) ? v : [v]).filter((x) => x && typeof x === "object");
  } catch {
    return [];
  }
}

/** The rate the bank row gets from a typed row's other-currency amount: the typed rate when the dollars are the same,
 * else worked out from the two amounts in integers (no floats), and none when that falls outside the column's range
 * (the CHECK would refuse the whole merge). */
export function mergedRate(manual: Pick<MovementRow, "orig_cents" | "fx_micros" | "fee_cents" | "amount_cents">, bankCents: number): number | null {
  if (!manual.orig_cents) return null;
  if (manual.fx_micros && manual.amount_cents === bankCents && !manual.fee_cents) return manual.fx_micros;
  if (bankCents < 1) return null;
  const micros = (BigInt(manual.orig_cents) * 1_000_000n + BigInt(bankCents) / 2n) / BigInt(bankCents);
  return micros >= 1n && micros <= 100_000_000_000_000n ? Number(micros) : null;
}

/**
 * Merge a hand-typed row into the bank row. The bank row keeps its own shop name, date and
 * source text; it takes the user's category, note and tags. The typed row is deleted.
 */
export async function mergeManualIntoBank(db: D1Database, userId: number, bankId: number, manualId: number) {
  const [bank, manual] = await Promise.all([getMovement(db, userId, bankId), getMovement(db, userId, manualId)]);
  if (!bank || !manual) throw new HTTPException(404, { message: "not_found" });
  if (bank.origen === "manual" || manual.origen !== "manual") throw new HTTPException(400, { message: "invalid:merge" });

  const now = Date.now();
  const categoryId = manual.category_id ?? bank.category_id;
  const nota = [bank.nota, manual.nota].filter(Boolean).join(" · ");
  const tags = JSON.stringify([...new Set([...parseTags(bank.tags), ...parseTags(manual.tags)])]);
  const stmts = [
    db.prepare(
      `UPDATE movements SET category_id = ?, nota = ?, tags = ?, estado = ?, updated_at = ?
       WHERE id = ? AND user_id = ?`,
    ).bind(categoryId, nota, tags, categoryId ? "ok" : "revisar", now, bank.id, userId),
    db.prepare("DELETE FROM merge_suggestions WHERE user_id = ? AND (bank_id = ? OR manual_id = ?)")
      .bind(userId, bank.id, manual.id),
    // Funciones: the typed row's Personas lines and other-currency amount move to the bank row before it goes
    db.prepare("UPDATE OR IGNORE person_entries SET movement_id = ? WHERE user_id = ? AND movement_id = ?").bind(bank.id, userId, manual.id),
    db.prepare(
      `UPDATE movements SET orig_currency = ?, orig_cents = ?, fx_micros = ?, fee_cents = NULL
       WHERE id = ? AND user_id = ? AND orig_currency IS NULL AND ? IS NOT NULL`,
    ).bind(manual.orig_currency ?? null, manual.orig_cents ?? null, mergedRate(manual, bank.amount_cents),
      bank.id, userId, manual.orig_currency ?? null),
    db.prepare("DELETE FROM movements WHERE id = ? AND user_id = ?").bind(manual.id, userId),
  ];
  if (categoryId && bank.merchant_key) stmts.push(rememberMerchant(db, userId, bank.merchant_key, categoryId, now));
  // The bank row may have come from a statement import (now, or earlier and merged in Revisar): keep a copy of the
  // typed row on that import's row, in this same write, so undoing the import brings the typed row back.
  const links = await db
    .prepare("SELECT id, prev FROM import_rows WHERE user_id = ? AND movement_id = ? AND kind IN ('added', 'merged')")
    .bind(userId, bank.id)
    .all<{ id: number; prev: string | null }>();
  for (const l of links.results) {
    stmts.push(
      db.prepare("UPDATE import_rows SET kind = 'merged', prev = ? WHERE id = ? AND user_id = ?")
        .bind(JSON.stringify([...prevRows(l.prev), manual]), l.id, userId),
    );
  }
  await db.batch(stmts);
  return { id: bank.id };
}

export type BankInput = {
  dedupe_key: string;
  fecha: string;
  hora: string | null;
  amount_cents: number;
  tipo: Tipo;
  comercio: string;
  account_id: number | null;
  origen: string;
  raw: string | null;
};

export type IngestResult =
  | { status: "duplicate" }
  | { status: "inserted"; id: number }
  | { status: "merged"; id: number; manual_id: number }
  | { status: "needs_review"; id: number; candidates: number[] };

/**
 * Save one movement that came from a bank (email or statement). Used by the BAC capture in Step 3
 * and by the tests. Never drops anything: unclear rows go to the review inbox.
 */
export async function ingestBankMovement(db: D1Database, userId: number, input: BankInput): Promise<IngestResult> {
  const b = { ...input, comercio: cleanText(input.comercio) }; // shop names come from outside (bank emails)
  const now = Date.now();
  const key = merchantKey(b.comercio);
  const ruleCategory = b.tipo === "gasto" || b.tipo === "abono" ? await lookupMerchant(db, userId, key) : null;
  const needsCategory = b.tipo === "gasto" || b.tipo === "abono";
  const estado = needsCategory && !ruleCategory ? "revisar" : "ok";
  const row = await db
    .prepare(
      `INSERT INTO movements (user_id, fecha, hora, amount_cents, tipo, comercio, merchant_key, account_id,
         category_id, tags, nota, origen, estado, raw, dedupe_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', '', ?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id, dedupe_key) DO NOTHING
       RETURNING id`,
    )
    .bind(userId, b.fecha, b.hora, b.amount_cents, b.tipo, b.comercio, key, b.account_id, ruleCategory,
      b.origen, estado, b.raw, b.dedupe_key, now, now)
    .first<{ id: number }>();
  if (!row) return { status: "duplicate" };
  if (b.tipo !== "gasto") return { status: "inserted", id: row.id };

  const matches = await findMatches(db, userId, { id: row.id, account_id: b.account_id, amount_cents: b.amount_cents, fecha: b.fecha }, "manual");
  if (matches.length === 1) {
    await mergeManualIntoBank(db, userId, row.id, matches[0].id);
    return { status: "merged", id: row.id, manual_id: matches[0].id };
  }
  if (matches.length > 1) {
    await db.batch([
      ...matches.map((m) =>
        db.prepare(
          `INSERT OR IGNORE INTO merge_suggestions (user_id, bank_id, manual_id, created_at) VALUES (?, ?, ?, ?)`,
        ).bind(userId, row.id, m.id, now),
      ),
      db.prepare("UPDATE movements SET estado = 'revisar' WHERE id = ? AND user_id = ?").bind(row.id, userId),
    ]);
    return { status: "needs_review", id: row.id, candidates: matches.map((m) => m.id) };
  }
  return { status: "inserted", id: row.id };
}
