import { HTTPException } from "hono/http-exception";
import type { MovementRow } from "../types.ts";

type OwnedTable = "accounts" | "categories" | "groups";

/** A referenced account, category or group must belong to the same user. */
export async function assertOwned(db: D1Database, table: OwnedTable, id: number, userId: number): Promise<void> {
  const row = await db.prepare(`SELECT id FROM ${table} WHERE id = ? AND user_id = ?`).bind(id, userId).first();
  if (!row) throw new HTTPException(400, { message: `invalid:${table}` });
}

export async function getMovement(db: D1Database, userId: number, id: number): Promise<MovementRow | null> {
  return db.prepare("SELECT * FROM movements WHERE id = ? AND user_id = ?").bind(id, userId).first<MovementRow>();
}

/** Statement that records "this shop is this category" for a user. */
export function rememberMerchant(db: D1Database, userId: number, key: string, categoryId: number, now: number) {
  return db
    .prepare(
      `INSERT INTO merchant_rules (user_id, merchant_key, category_id, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id, merchant_key) DO UPDATE SET category_id = excluded.category_id, updated_at = excluded.updated_at`,
    )
    .bind(userId, key, categoryId, now);
}

export async function lookupMerchant(db: D1Database, userId: number, key: string): Promise<number | null> {
  if (!key) return null;
  const r = await db
    .prepare(
      `SELECT r.category_id FROM merchant_rules r JOIN categories c ON c.id = r.category_id
       WHERE r.user_id = ? AND r.merchant_key = ? AND c.archived = 0`,
    )
    .bind(userId, key)
    .first<{ category_id: number }>();
  return r?.category_id ?? null;
}
