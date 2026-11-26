// Recurrentes (Más → Recurrentes): fixed payments she expects (rent, phone, a subscription). The app only shows
// them and counts what is still to come this month; it never creates a movement on its own.
import { Hono } from "hono";
import { z } from "zod";
import { isValidFecha, shiftDays, svNow } from "../lib/dates.ts";
import { idParam, notFound, readBody } from "../lib/http.ts";
import { merchantKey } from "../lib/merchant.ts";
import { MAX_CENTS } from "../lib/money.ts";
import { assertOwned } from "../lib/owned.ts";
import { findRecurring, type SpendRow } from "../lib/recurring.ts";
import { type Charge, EVERY, everyFromDays, matchOccurrences, occurrences, type RecurringRow, windowDays } from "../lib/upcoming.ts";
import type { AppEnv } from "../types.ts";

export const recurringRoutes = new Hono<AppEnv>();

const fecha = z.string().refine((f) => isValidFecha(f) && f >= "2020-01-01" && f <= "2040-12-31", "fecha");
const Body = z.object({
  name: z.string().trim().min(1).max(80),
  amount_cents: z.number().int().min(1).max(MAX_CENTS),
  every: z.enum(EVERY),
  next_date: fecha,
  account_id: z.number().int().positive().nullable().optional(),
  category_id: z.number().int().positive().nullable().optional(),
  /** set when she keeps one of the app's suggestions: the shop the charges come from */
  merchant_key: z.string().trim().max(80).optional(),
});
const Patch = Body.partial().omit({ merchant_key: true });
const MAX_RULES = 60;

/** Importar's "keep" answers (Primeros pasos) become Recurrentes once, from the last charge of that shop. A deleted
 * one stays as a switched-off row, so it never comes back. */
export async function adoptChoices(db: D1Database, userId: number, now: number): Promise<void> {
  // One query for every kept answer with its shop's last charge (D1 allows 50 queries a request on the free plan, and
  // Importar may have kept many): never one query per answer.
  const { results: choices } = await db
    .prepare(
      `SELECT rc.merchant_key, rc.amount_cents, rc.every_days, m.comercio, m.fecha, m.account_id, m.category_id
       FROM recurring_choices rc
       JOIN movements m ON m.id = (SELECT id FROM movements WHERE user_id = rc.user_id AND tipo = 'gasto' AND merchant_key = rc.merchant_key
                                   ORDER BY fecha DESC, id DESC LIMIT 1)
       WHERE rc.user_id = ? AND rc.keep = 1 AND rc.merchant_key <> '' AND rc.amount_cents >= 1
         AND NOT EXISTS (SELECT 1 FROM recurring r WHERE r.user_id = rc.user_id AND r.merchant_key = rc.merchant_key)
       ORDER BY rc.updated_at, rc.merchant_key LIMIT ?`,
    )
    .bind(userId, MAX_RULES)
    .all<{ merchant_key: string; amount_cents: number; every_days: number; comercio: string; fecha: string; account_id: number | null; category_id: number | null }>();
  if (!choices.length) return;
  const today = svNow(now).fecha;
  const stmts: D1PreparedStatement[] = [];
  for (const ch of choices) {
    const every = everyFromDays(ch.every_days);
    // the first date after today, stepping from the last charge
    const next = occurrences({ every, next_date: ch.fecha }, shiftDays(today, 1), shiftDays(today, 400))[0] ?? shiftDays(today, 1);
    stmts.push(db.prepare(
      `INSERT INTO recurring (user_id, name, merchant_key, amount_cents, every, next_date, account_id, category_id, source, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'import', 1, ?, ?) ON CONFLICT DO NOTHING`,
    ).bind(userId, (ch.comercio || ch.merchant_key).slice(0, 80), ch.merchant_key, Math.min(ch.amount_cents, MAX_CENTS), every, next,
      ch.account_id, ch.category_id, now, now));
  }
  await db.batch(stmts);
}

async function suggestions(db: D1Database, userId: number, today: string) {
  const [moves, taken] = await db.batch([
    db.prepare("SELECT merchant_key, comercio, fecha, amount_cents FROM movements WHERE user_id = ? AND tipo = 'gasto' AND fecha >= ?")
      .bind(userId, shiftDays(today, -120)),
    db.prepare(
      `SELECT merchant_key FROM recurring WHERE user_id = ? AND merchant_key <> ''
       UNION SELECT merchant_key FROM recurring_choices WHERE user_id = ? AND keep = 0`,
    ).bind(userId, userId),
  ]);
  const skip = new Set((taken.results as { merchant_key: string }[]).map((r) => r.merchant_key));
  return findRecurring(moves.results as SpendRow[]).filter((r) => !skip.has(r.merchant_key)).slice(0, 8);
}

async function checkLinks(db: D1Database, userId: number, b: { account_id?: number | null; category_id?: number | null }) {
  if (b.account_id) await assertOwned(db, "accounts", b.account_id, userId);
  if (b.category_id) await assertOwned(db, "categories", b.category_id, userId);
}

recurringRoutes.get("/recurring", async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const now = Date.now();
  const today = svNow(now).fecha;
  await adoptChoices(db, user.id, now);
  const { results: rules } = await db
    .prepare(
      `SELECT id, name, merchant_key, amount_cents, every, next_date, account_id, category_id, active, source
       FROM recurring WHERE user_id = ? AND active = 1 ORDER BY name COLLATE NOCASE, id`,
    )
    .bind(user.id)
    .all<RecurringRow & { source: string }>();
  const from = shiftDays(today, -45);
  const to = shiftDays(today, 400);
  const { results: charges } = await db
    .prepare("SELECT id, fecha, amount_cents, merchant_key, category_id, account_id FROM movements WHERE user_id = ? AND tipo = 'gasto' AND fecha >= ?")
    .bind(user.id, shiftDays(from, -7))
    .all<Charge>();
  const occ = matchOccurrences(rules, charges, from, to);
  const items = rules.map((r) => {
    const mine = occ.filter((o) => o.recurring_id === r.id);
    const next = mine.find((o) => o.paid_by == null && o.fecha >= shiftDays(today, -windowDays(r.every)));
    const paid = mine.filter((o) => o.paid_by != null).pop();
    return {
      id: r.id, name: r.name, amount_cents: r.amount_cents, every: r.every, account_id: r.account_id, category_id: r.category_id,
      source: r.source, from_shop: r.merchant_key !== "",
      next_date: next?.fecha ?? null, late: !!next && next.fecha < today, last_paid: paid?.fecha ?? null,
    };
  });
  return c.json({ today, items, suggestions: await suggestions(db, user.id, today) });
});

recurringRoutes.post("/recurring", async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const b = await readBody(c, Body);
  await checkLinks(db, user.id, b);
  const n = await db.prepare("SELECT COUNT(*) AS n FROM recurring WHERE user_id = ? AND active = 1").bind(user.id).first<{ n: number }>();
  if ((n?.n ?? 0) >= MAX_RULES) return c.json({ error: "too_many" }, 409);
  const now = Date.now();
  // a kept suggestion uses the shop's own key; one she types by name matches the shop by that name
  const key = merchantKey(b.merchant_key ?? b.name);
  const row = await db
    .prepare(
      `INSERT INTO recurring (user_id, name, merchant_key, amount_cents, every, next_date, account_id, category_id, source, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT (user_id, merchant_key) WHERE merchant_key <> '' DO UPDATE SET name = excluded.name, amount_cents = excluded.amount_cents,
         every = excluded.every, next_date = excluded.next_date, account_id = excluded.account_id, category_id = excluded.category_id,
         active = 1, updated_at = excluded.updated_at
       RETURNING id`,
    )
    .bind(user.id, b.name, key, b.amount_cents, b.every, b.next_date, b.account_id ?? null, b.category_id ?? null,
      b.merchant_key ? "suggested" : "manual", now, now)
    .first<{ id: number }>();
  return c.json({ id: row!.id }, 201);
});

recurringRoutes.put("/recurring/:id", async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const id = idParam(c);
  const cur = await db.prepare("SELECT * FROM recurring WHERE id = ? AND user_id = ? AND active = 1").bind(id, user.id).first<RecurringRow & { source: string }>();
  if (!cur) notFound();
  const b = await readBody(c, Patch);
  await checkLinks(db, user.id, b);
  const next = { ...cur, ...Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined)) } as RecurringRow;
  // a rule she typed follows its name; a shop's rule keeps matching that shop
  const key = cur.source === "manual" ? merchantKey(next.name) : cur.merchant_key;
  const clash = key && key !== cur.merchant_key
    ? await db.prepare("SELECT 1 FROM recurring WHERE user_id = ? AND merchant_key = ? AND id <> ?").bind(user.id, key, id).first()
    : null;
  await db
    .prepare(
      `UPDATE recurring SET name = ?, merchant_key = ?, amount_cents = ?, every = ?, next_date = ?, account_id = ?, category_id = ?, updated_at = ?
       WHERE id = ? AND user_id = ?`,
    )
    .bind(next.name, clash ? cur.merchant_key : key, next.amount_cents, next.every, next.next_date, next.account_id ?? null,
      next.category_id ?? null, Date.now(), id, user.id)
    .run();
  return c.json({ ok: true });
});

/** Deleting switches the row off (it stays, so a suggestion or Importar's answer never brings it back). */
recurringRoutes.delete("/recurring/:id", async (c) => {
  const user = c.get("user");
  const id = idParam(c);
  const r = await c.env.DB.prepare("UPDATE recurring SET active = 0, updated_at = ? WHERE id = ? AND user_id = ? AND active = 1")
    .bind(Date.now(), id, user.id).run();
  if (!r.meta.changes) notFound();
  return c.json({ ok: true });
});

/** "No es fijo": a suggestion she does not want is not offered again (same answer as Importar's step). */
recurringRoutes.post("/recurring/dismiss", async (c) => {
  const user = c.get("user");
  const b = await readBody(c, z.object({ merchant_key: z.string().trim().min(1).max(80) }));
  const n = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM recurring_choices WHERE user_id = ?").bind(user.id).first<{ n: number }>();
  if ((n?.n ?? 0) >= 200) return c.json({ error: "too_many" }, 409);
  await c.env.DB
    .prepare(
      `INSERT INTO recurring_choices (user_id, merchant_key, keep, amount_cents, every_days, updated_at) VALUES (?, ?, 0, 0, 30, ?)
       ON CONFLICT (user_id, merchant_key) DO UPDATE SET keep = 0, updated_at = excluded.updated_at`,
    )
    .bind(user.id, b.merchant_key, Date.now())
    .run();
  return c.json({ ok: true });
});
