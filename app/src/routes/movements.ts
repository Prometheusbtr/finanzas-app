import { Hono } from "hono";
import { z } from "zod";
import { isAllowedFecha, isValidMonth, monthBounds, svNow } from "../lib/dates.ts";
import { idParam, notFound, readBody } from "../lib/http.ts";
import { findMatches, mergeManualIntoBank } from "../lib/merge.ts";
import { merchantKey } from "../lib/merchant.ts";
import { MAX_CENTS } from "../lib/money.ts";
import { fxColumns, FxSchema } from "../lib/fx.ts";
import { assertOwned, getMovement, lookupMerchant, rememberMerchant } from "../lib/owned.ts";
import { type AppEnv, type MovementRow, publicMovement, TIPOS } from "../types.ts";

export const movementRoutes = new Hono<AppEnv>();

const SPENDING = new Set(["gasto", "abono"]);
const MAX_OFFSET = 100_000; // far past any real history; stops huge scans
const hora = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
// A real date from 2000 up to tomorrow (El Salvador time). Anything else is a typo or an attack.
const fecha = z.string().refine((f) => isAllowedFecha(f), "fecha");
const tags = z.array(z.string().trim().min(1).max(40)).max(10);

const CreateSchema = z.object({
  client_id: z.string().regex(/^[A-Za-z0-9-]{8,64}$/),
  amount_cents: z.number().int().min(1).max(MAX_CENTS),
  fecha: fecha.optional(),
  hora: hora.nullable().optional(),
  tipo: z.enum(["gasto", "abono", "ingreso", "interno"]).default("gasto"),
  comercio: z.string().trim().max(200).default(""),
  account_id: z.number().int().positive(),
  category_id: z.number().int().positive().nullable().optional(),
  nota: z.string().trim().max(500).default(""),
  tags: tags.default([]),
  fx: FxSchema.nullable().optional(),
});

const UpdateSchema = z.object({
  amount_cents: z.number().int().min(1).max(MAX_CENTS).optional(),
  fecha: fecha.optional(),
  hora: hora.nullable().optional(),
  tipo: z.enum(TIPOS).optional(),
  comercio: z.string().trim().max(200).optional(),
  account_id: z.number().int().positive().nullable().optional(),
  category_id: z.number().int().positive().nullable().optional(),
  nota: z.string().trim().max(500).optional(),
  tags: tags.optional(),
  estado: z.enum(["ok", "revisar"]).optional(),
  remember: z.boolean().default(true),
  fx: FxSchema.nullable().optional(),
});

function likeEscape(s: string) {
  return s.replace(/[\\%_]/g, (m) => "\\" + m);
}

movementRoutes.get("/movements", async (c) => {
  const user = c.get("user");
  const q = c.req.query();
  const where = ["m.user_id = ?"];
  const binds: (string | number)[] = [user.id];
  if (q.month && isValidMonth(q.month)) {
    const b = monthBounds(q.month);
    where.push("m.fecha BETWEEN ? AND ?");
    binds.push(b.start, b.end);
  }
  if (q.q) {
    where.push("(m.comercio LIKE ? ESCAPE '\\' OR m.nota LIKE ? ESCAPE '\\')");
    const like = `%${likeEscape(q.q.slice(0, 80))}%`;
    binds.push(like, like);
  }
  for (const [param, col] of [["category_id", "m.category_id"], ["account_id", "m.account_id"], ["group_id", "c.group_id"]] as const) {
    const v = Number(q[param]);
    if (q[param] && Number.isSafeInteger(v)) {
      where.push(`${col} = ?`);
      binds.push(v);
    }
  }
  if (q.tipo && (TIPOS as readonly string[]).includes(q.tipo)) {
    where.push("m.tipo = ?");
    binds.push(q.tipo);
  } else if (q.tipo === "gastos") {
    where.push("m.tipo IN ('gasto', 'abono')");
  }
  if (q.estado === "revisar" || q.estado === "ok") {
    where.push("m.estado = ?");
    binds.push(q.estado);
  }
  if (q.tag) {
    where.push("EXISTS (SELECT 1 FROM json_each(m.tags) t WHERE t.value = ?)");
    binds.push(q.tag.slice(0, 40));
  }
  const limit = Math.min(Math.max(Math.trunc(Number(q.limit)) || 100, 1), 300);
  const offset = Math.min(Math.max(Math.trunc(Number(q.offset)) || 0, 0), MAX_OFFSET);
  const { results } = await c.env.DB
    .prepare(
      `SELECT m.* FROM movements m LEFT JOIN categories c ON c.id = m.category_id
       WHERE ${where.join(" AND ")}
       ORDER BY m.fecha DESC, COALESCE(m.hora, '') DESC, m.id DESC
       LIMIT ? OFFSET ?`,
    )
    .bind(...binds, limit + 1, offset)
    .all<MovementRow>();
  return c.json({ items: results.slice(0, limit).map(publicMovement), has_more: results.length > limit });
});

movementRoutes.get("/movements/:id", async (c) => {
  const m = await getMovement(c.env.DB, c.get("user").id, idParam(c));
  if (!m) notFound();
  return c.json({ movement: publicMovement(m) });
});

/** Suggest a category for a shop name the user is typing. */
movementRoutes.get("/suggest", async (c) => {
  const key = merchantKey(c.req.query("comercio") ?? "");
  return c.json({ category_id: await lookupMerchant(c.env.DB, c.get("user").id, key) });
});

movementRoutes.post("/movements", async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const b = await readBody(c, CreateSchema);
  await assertOwned(db, "accounts", b.account_id, user.id);
  if (b.category_id) await assertOwned(db, "categories", b.category_id, user.id);

  const now = Date.now();
  const today = svNow(now);
  const f = b.fecha ?? today.fecha;
  const h = b.hora !== undefined ? b.hora : f === today.fecha ? today.hora : null;
  const key = merchantKey(b.comercio);
  let categoryId = b.category_id ?? null;
  if (!categoryId && SPENDING.has(b.tipo)) categoryId = await lookupMerchant(db, user.id, key);
  const estado = SPENDING.has(b.tipo) && !categoryId ? "revisar" : "ok";
  const dedupeKey = `manual:${b.client_id}`;
  const fx = fxColumns(b.fx, b.amount_cents);

  const inserted = await db
    .prepare(
      `INSERT INTO movements (user_id, fecha, hora, amount_cents, tipo, comercio, merchant_key, account_id,
         category_id, tags, nota, origen, estado, raw, dedupe_key, created_at, updated_at,
         orig_currency, orig_cents, fx_micros, fee_cents)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, NULL, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id, dedupe_key) DO NOTHING
       RETURNING *`,
    )
    .bind(user.id, f, h, b.amount_cents, b.tipo, b.comercio, key, b.account_id, categoryId,
      JSON.stringify([...new Set(b.tags)]), b.nota, estado, dedupeKey, now, now, ...fx)
    .first<MovementRow>();

  if (!inserted) {
    // Same client_id sent twice (double tap or a retry on bad signal): return the saved one.
    const existing = await db
      .prepare("SELECT * FROM movements WHERE user_id = ? AND dedupe_key = ?")
      .bind(user.id, dedupeKey)
      .first<MovementRow>();
    return c.json({ movement: existing ? publicMovement(existing) : null, duplicate: true, possible_duplicates: [] });
  }
  if (b.category_id && key) await rememberMerchant(db, user.id, key, b.category_id, now).run();

  const matches = inserted.tipo === "gasto" ? await findMatches(db, user.id, inserted, "bank") : [];
  return c.json({ movement: publicMovement(inserted), duplicate: false, possible_duplicates: matches.map(publicMovement) }, 201);
});

movementRoutes.put("/movements/:id", async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const id = idParam(c);
  const cur = await getMovement(db, user.id, id);
  if (!cur) notFound();
  const b = await readBody(c, UpdateSchema);
  if (b.account_id) await assertOwned(db, "accounts", b.account_id, user.id);
  if (b.category_id) await assertOwned(db, "categories", b.category_id, user.id);

  const next = { ...cur };
  for (const k of ["amount_cents", "fecha", "hora", "tipo", "comercio", "account_id", "category_id", "nota", "estado"] as const) {
    if (b[k] !== undefined) (next as Record<string, unknown>)[k] = b[k];
  }
  if (b.tags) next.tags = JSON.stringify([...new Set(b.tags)]);
  if (b.comercio !== undefined) next.merchant_key = merchantKey(b.comercio);
  if (b.estado === undefined && (b.category_id !== undefined || b.tipo !== undefined)) {
    // A spending row with no category waits in the review inbox; anything else is done.
    next.estado = SPENDING.has(next.tipo) && !next.category_id ? "revisar" : "ok";
  }
  // F14: a purchase split with someone in Personas: its shares must still fit in it and it must stay a purchase, or
  // the edit asks her to change the shares first (409 has_shares). A "they paid" line follows the new amount.
  const amountChanged = next.amount_cents !== cur.amount_cents;
  const tipoChanged = next.tipo !== cur.tipo;
  let theyPaid = false;
  let settle = false;
  if (amountChanged || tipoChanged) {
    const e = await db
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN kind IN ('paid_for', 'shared') THEN cents END), 0) AS shares,
           COUNT(CASE WHEN kind = 'they_paid' THEN 1 END) AS they, COUNT(CASE WHEN kind = 'settle' THEN 1 END) AS settle
         FROM person_entries WHERE user_id = ? AND movement_id = ?`,
      )
      .bind(user.id, id)
      .first<{ shares: number; they: number; settle: number }>();
    const shares = e?.shares ?? 0;
    theyPaid = (e?.they ?? 0) > 0;
    settle = (e?.settle ?? 0) > 0;
    if ((shares > 0 || theyPaid) && tipoChanged && next.tipo !== "gasto") return c.json({ error: "has_shares", shares_cents: shares }, 409);
    if (shares > next.amount_cents) return c.json({ error: "has_shares", shares_cents: shares }, 409);
  }
  const now = Date.now();
  // the other currency: sent = set or clear it; not sent = keep it (a fee never above the new amount)
  const fx = b.fx !== undefined
    ? fxColumns(b.fx, next.amount_cents)
    : [cur.orig_currency ?? null, cur.orig_cents ?? null, cur.fx_micros ?? null, cur.fee_cents != null && cur.fee_cents > next.amount_cents ? null : (cur.fee_cents ?? null)];
  const stmts = [
    db.prepare(
      `UPDATE movements SET amount_cents = ?, fecha = ?, hora = ?, tipo = ?, comercio = ?, merchant_key = ?,
         account_id = ?, category_id = ?, tags = ?, nota = ?, estado = ?, updated_at = ?,
         orig_currency = ?, orig_cents = ?, fx_micros = ?, fee_cents = ?
       WHERE id = ? AND user_id = ?`,
    ).bind(next.amount_cents, next.fecha, next.hora, next.tipo, next.comercio, next.merchant_key, next.account_id,
      next.category_id, next.tags, next.nota, next.estado, now, ...fx, id, user.id),
  ];
  if (b.remember && b.category_id && next.merchant_key && SPENDING.has(next.tipo)) {
    stmts.push(rememberMerchant(db, user.id, next.merchant_key, b.category_id, now));
  }
  if (theyPaid && amountChanged) {
    stmts.push(db.prepare("UPDATE person_entries SET cents = ? WHERE user_id = ? AND movement_id = ? AND kind = 'they_paid'").bind(-next.amount_cents, user.id, id));
  }
  if (settle && amountChanged) {
    // Seguridad W5: a "Saldar" transfer fixed to a new amount: the line follows it, money in stays negative
    stmts.push(db.prepare("UPDATE person_entries SET cents = CASE WHEN cents < 0 THEN -? ELSE ? END WHERE user_id = ? AND movement_id = ? AND kind = 'settle'")
      .bind(next.amount_cents, next.amount_cents, user.id, id));
  }
  await db.batch(stmts);
  return c.json({ movement: publicMovement((await getMovement(db, user.id, id))!) });
});

movementRoutes.delete("/movements/:id", async (c) => {
  const user = c.get("user");
  const id = idParam(c);
  const r = await c.env.DB.prepare("DELETE FROM movements WHERE id = ? AND user_id = ?").bind(id, user.id).run();
  if (!r.meta.changes) notFound();
  return c.json({ ok: true });
});

/** The user confirms a typed purchase is the same as a bank one. */
movementRoutes.post("/movements/:id/merge", async (c) => {
  const user = c.get("user");
  const manualId = idParam(c);
  const { bank_id } = await readBody(c, z.object({ bank_id: z.number().int().positive() }));
  const r = await mergeManualIntoBank(c.env.DB, user.id, bank_id, manualId);
  return c.json({ movement: publicMovement((await getMovement(c.env.DB, user.id, r.id))!) });
});
