// Tarjetas (Más → Tarjetas, and the card fields of Primeros pasos step 2): closing day, due day and credit limit
// per card account, the next dates, and what the card has spent since its last closing. Never a card number.
import { Hono } from "hono";
import { z } from "zod";
import { isValidFecha, svNow } from "../lib/dates.ts";
import { deleteCardStatements, lastClosing, loadCards, nextClosing, nextDue, recordCardStatement } from "../lib/cards.ts";
import { idParam, notFound, readBody } from "../lib/http.ts";
import { MAX_CENTS } from "../lib/money.ts";
import type { AppEnv } from "../types.ts";

export const cardRoutes = new Hono<AppEnv>();

const day = z.number().int().min(1).max(31).nullable();
const Settings = z.object({ closing_day: day.optional(), due_day: day.optional(), limit_cents: z.number().int().min(0).max(MAX_CENTS).nullable().optional() });
const date = z.string().refine((f) => isValidFecha(f) && f >= "2020-01-01" && f <= "2040-12-31", "fecha");
const Statement = z.object({
  closing_date: date,
  due_date: date.nullable().optional(),
  min_cents: z.number().int().min(0).max(MAX_CENTS).nullable().optional(),
  full_cents: z.number().int().min(0).max(MAX_CENTS).nullable().optional(),
  /** the statement she opened: a new closing date corrects that row */
  id: z.number().int().min(1).nullable().optional(),
});

cardRoutes.get("/cards", async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const today = svNow().fecha;
  const cards = await loadCards(db, user.id);
  const out = [];
  for (const k of cards) {
    const closed = lastClosing(k, today);
    // spending on the card since its last closing: what the next statement will hold so far
    const used = closed
      ? await db
          .prepare(
            `SELECT COALESCE(SUM(CASE tipo WHEN 'gasto' THEN amount_cents WHEN 'abono' THEN -amount_cents ELSE 0 END), 0) AS cents
             FROM movements WHERE user_id = ? AND account_id = ? AND fecha > ? AND fecha <= ?`,
          )
          .bind(user.id, k.account_id, closed, today)
          .first<{ cents: number }>()
      : null;
    out.push({
      account_id: k.account_id, name: k.name, closing_day: k.closing_day, due_day: k.due_day, limit_cents: k.limit_cents,
      last_closing: closed, next_closing: nextClosing(k, today), next_due: nextDue(k, today),
      statement: k.st_closing ? { id: k.st_id, closing_date: k.st_closing, due_date: k.st_due, min_cents: k.st_min, full_cents: k.st_full } : null,
      cycle_spent_cents: used?.cents ?? null,
    });
  }
  return c.json({ today, cards: out });
});

cardRoutes.put("/cards/:id", async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const id = idParam(c);
  const own = await db.prepare("SELECT 1 FROM accounts WHERE id = ? AND user_id = ? AND kind = 'tarjeta'").bind(id, user.id).first();
  if (!own) notFound();
  const b = await readBody(c, Settings);
  const cur = await db.prepare("SELECT closing_day, due_day, limit_cents FROM cards WHERE account_id = ? AND user_id = ?").bind(id, user.id)
    .first<{ closing_day: number | null; due_day: number | null; limit_cents: number | null }>();
  const next = { closing_day: null, due_day: null, limit_cents: null, ...cur, ...Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined)) };
  await db
    .prepare(
      `INSERT INTO cards (account_id, user_id, closing_day, due_day, limit_cents, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (account_id) DO UPDATE SET closing_day = excluded.closing_day, due_day = excluded.due_day,
         limit_cents = excluded.limit_cents, updated_at = excluded.updated_at`,
    )
    .bind(id, user.id, next.closing_day, next.due_day, next.limit_cents, Date.now())
    .run();
  return c.json({ ok: true });
});

/** A statement's dates and payments typed by hand (the BAC email script calls recordCardStatement directly). */
cardRoutes.post("/cards/:id/statement", async (c) => {
  const user = c.get("user");
  const id = idParam(c);
  const own = await c.env.DB.prepare("SELECT 1 FROM accounts WHERE id = ? AND user_id = ? AND kind = 'tarjeta'").bind(id, user.id).first();
  if (!own) notFound();
  const b = await readBody(c, Statement);
  if (b.due_date && b.due_date < b.closing_date) return c.json({ error: "invalid:due_date" }, 400);
  await recordCardStatement(c.env.DB, user.id, id, b, "manual", Date.now(), b.id);
  return c.json({ ok: true });
});

/** "Borrar datos de esta tarjeta", or an emptied Fecha de corte: delete its saved statement (?st=id) or all of them.
 * Movements never change. */
cardRoutes.delete("/cards/:id/statement", async (c) => {
  const user = c.get("user");
  const id = idParam(c);
  const own = await c.env.DB.prepare("SELECT 1 FROM accounts WHERE id = ? AND user_id = ? AND kind = 'tarjeta'").bind(id, user.id).first();
  if (!own) notFound();
  const st = c.req.query("st");
  if (st !== undefined && !/^[1-9]\d{0,15}$/.test(st)) return c.json({ error: "invalid:st" }, 400);
  const removed = await deleteCardStatements(c.env.DB, user.id, id, st ? Number(st) : null);
  return c.json({ ok: true, removed });
});
