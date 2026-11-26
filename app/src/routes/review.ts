import { Hono } from "hono";
import { z } from "zod";
import { idParam, notFound, readBody } from "../lib/http.ts";
import { mergeManualIntoBank } from "../lib/merge.ts";
import { assertOwned, getMovement, rememberMerchant } from "../lib/owned.ts";
import { type AppEnv, type MovementRow, publicMovement } from "../types.ts";

export const reviewRoutes = new Hono<AppEnv>();

reviewRoutes.get("/review", async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  // F21: the rows behind the suggestions come from a subquery, never from a list of ids (D1 allows 100 bound values).
  const [items, sugg, rowsRes] = await db.batch([
    db.prepare(
      `SELECT * FROM movements m WHERE m.user_id = ? AND m.estado = 'revisar'
         AND NOT EXISTS (SELECT 1 FROM merge_suggestions s WHERE s.user_id = m.user_id AND s.bank_id = m.id)
       ORDER BY m.fecha DESC, m.id DESC LIMIT 200`,
    ).bind(user.id),
    db.prepare("SELECT s.id AS sid, s.bank_id, s.manual_id FROM merge_suggestions s WHERE s.user_id = ? ORDER BY s.bank_id, s.id").bind(user.id),
    db.prepare(
      `SELECT * FROM movements WHERE user_id = ? AND id IN (
         SELECT bank_id FROM merge_suggestions WHERE user_id = ? UNION SELECT manual_id FROM merge_suggestions WHERE user_id = ?)`,
    ).bind(user.id, user.id, user.id),
  ]);
  const rows = new Map((rowsRes.results as MovementRow[]).map((r) => [r.id, r]));
  const suggestions = (sugg.results as { sid: number; bank_id: number; manual_id: number }[])
    .filter((s) => rows.has(s.bank_id) && rows.has(s.manual_id))
    .map((s) => ({ id: s.sid, bank: publicMovement(rows.get(s.bank_id)!), manual: publicMovement(rows.get(s.manual_id)!) }));
  return c.json({ items: (items.results as MovementRow[]).map(publicMovement), suggestions });
});

/** One tap: set the category, remember the shop, and sort the other waiting rows from the same shop. */
reviewRoutes.post("/review/:id/categorize", async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const id = idParam(c);
  const { category_id, apply_same } = await readBody(
    c,
    z.object({ category_id: z.number().int().positive(), apply_same: z.boolean().default(true) }),
  );
  const m = await getMovement(db, user.id, id);
  if (!m) notFound();
  await assertOwned(db, "categories", category_id, user.id);
  const now = Date.now();
  const stmts = [
    db.prepare("UPDATE movements SET category_id = ?, estado = 'ok', updated_at = ? WHERE id = ? AND user_id = ?")
      .bind(category_id, now, id, user.id),
  ];
  let others = 0;
  if (m.merchant_key) {
    stmts.push(rememberMerchant(db, user.id, m.merchant_key, category_id, now));
    if (apply_same) {
      const r = await db
        .prepare(
          `SELECT COUNT(*) AS n FROM movements m WHERE user_id = ? AND merchant_key = ? AND estado = 'revisar'
             AND tipo IN ('gasto', 'abono') AND id <> ?
             AND NOT EXISTS (SELECT 1 FROM merge_suggestions s WHERE s.user_id = m.user_id AND s.bank_id = m.id)`,
        )
        .bind(user.id, m.merchant_key, id)
        .first<{ n: number }>();
      others = r?.n ?? 0;
      stmts.push(
        db.prepare(
          `UPDATE movements SET category_id = ?, estado = 'ok', updated_at = ?
           WHERE user_id = ? AND merchant_key = ? AND estado = 'revisar' AND tipo IN ('gasto', 'abono') AND id <> ?
             AND NOT EXISTS (SELECT 1 FROM merge_suggestions s WHERE s.user_id = movements.user_id AND s.bank_id = movements.id)`,
        ).bind(category_id, now, user.id, m.merchant_key, id),
      );
    }
  }
  await db.batch(stmts);
  return c.json({ ok: true, also_updated: others });
});

async function getSuggestion(db: D1Database, userId: number, id: number) {
  const s = await db
    .prepare("SELECT id, bank_id, manual_id FROM merge_suggestions WHERE id = ? AND user_id = ?")
    .bind(id, userId)
    .first<{ id: number; bank_id: number; manual_id: number }>();
  if (!s) notFound();
  return s;
}

reviewRoutes.post("/suggestions/:id/accept", async (c) => {
  const user = c.get("user");
  const s = await getSuggestion(c.env.DB, user.id, idParam(c));
  const r = await mergeManualIntoBank(c.env.DB, user.id, s.bank_id, s.manual_id);
  return c.json({ ok: true, id: r.id });
});

/** "They are different purchases": keep both. */
reviewRoutes.post("/suggestions/:id/reject", async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const s = await getSuggestion(db, user.id, idParam(c));
  await db.prepare("DELETE FROM merge_suggestions WHERE id = ? AND user_id = ?").bind(s.id, user.id).run();
  const left = await db.prepare("SELECT COUNT(*) AS n FROM merge_suggestions WHERE user_id = ? AND bank_id = ?").bind(user.id, s.bank_id).first<{ n: number }>();
  if (!left?.n) {
    await db
      .prepare(
        `UPDATE movements SET estado = CASE WHEN category_id IS NULL AND tipo IN ('gasto', 'abono') THEN 'revisar' ELSE 'ok' END
         WHERE id = ? AND user_id = ?`,
      )
      .bind(s.bank_id, user.id)
      .run();
  }
  return c.json({ ok: true });
});
