// Personas (Más → Personas): who owes whom. Her own list of people (not app users): she paid for someone, split a
// bill, someone paid for her, and "Saldar" when the money comes back or goes out.
// Spending never changes because of a share: what she paid is still her spending (her part comes back as money,
// and a repayment is tipo interno, never spending). Only "someone paid for me" adds spending: that purchase is hers.
import { Hono } from "hono";
import { z } from "zod";
import { isAllowedFecha, svNow } from "../lib/dates.ts";
import { idParam, notFound, readBody } from "../lib/http.ts";
import { merchantKey } from "../lib/merchant.ts";
import { MAX_CENTS } from "../lib/money.ts";
import { assertOwned, getMovement } from "../lib/owned.ts";
import { type AppEnv, type MovementRow, publicMovement } from "../types.ts";

export const peopleRoutes = new Hono<AppEnv>();

const name = z.string().trim().min(1).max(60);
const fecha = z.string().refine((f) => isAllowedFecha(f), "fecha");
const cents = z.number().int().min(1).max(MAX_CENTS);
const clientId = z.string().regex(/^[A-Za-z0-9-]{8,64}$/);
const nota = z.string().trim().max(200).default("");
const MAX_PEOPLE = 100;

type PersonRow = { id: number; name: string; archived: number };

async function person(db: D1Database, userId: number, id: number): Promise<PersonRow> {
  const p = await db.prepare("SELECT id, name, archived FROM people WHERE id = ? AND user_id = ?").bind(id, userId).first<PersonRow>();
  if (!p) notFound();
  return p;
}

/** Whether Personas shows on Home and in Primeros pasos: her "shared" life answer, or anyone already in the list. */
export async function peopleOn(db: D1Database, userId: number): Promise<boolean> {
  const r = await db
    .prepare(
      `SELECT (SELECT data FROM setup_steps WHERE user_id = ? AND step = 'life') AS life,
         EXISTS (SELECT 1 FROM people WHERE user_id = ?) AS any`,
    )
    .bind(userId, userId)
    .first<{ life: string | null; any: number }>();
  let shared = false;
  try {
    shared = JSON.parse(r?.life ?? "{}")?.shared === true;
  } catch {
    shared = false;
  }
  return shared || r?.any === 1;
}

peopleRoutes.get("/people", async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const { results } = await db
    .prepare(
      `SELECT p.id, p.name, p.archived, COALESCE(SUM(e.cents), 0) AS balance_cents, COUNT(e.id) AS entries, MAX(e.fecha) AS last_fecha
       FROM people p LEFT JOIN person_entries e ON e.person_id = p.id AND e.user_id = p.user_id
       WHERE p.user_id = ? GROUP BY p.id ORDER BY p.archived, p.name COLLATE NOCASE`,
    )
    .bind(user.id)
    .all();
  return c.json({ on: await peopleOn(db, user.id), people: results });
});

peopleRoutes.post("/people", async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const b = await readBody(c, z.object({ name }));
  const n = await db.prepare("SELECT COUNT(*) AS n FROM people WHERE user_id = ?").bind(user.id).first<{ n: number }>();
  if ((n?.n ?? 0) >= MAX_PEOPLE) return c.json({ error: "too_many" }, 409);
  const row = await db
    .prepare("INSERT INTO people (user_id, name, created_at) VALUES (?, ?, ?) ON CONFLICT (user_id, name) DO UPDATE SET archived = 0 RETURNING id")
    .bind(user.id, b.name, Date.now())
    .first<{ id: number }>();
  return c.json({ id: row!.id }, 201);
});

peopleRoutes.put("/people/:id", async (c) => {
  const user = c.get("user");
  const id = idParam(c);
  const cur = await person(c.env.DB, user.id, id);
  const b = await readBody(c, z.object({ name: name.optional(), archived: z.boolean().optional() }));
  const clash = b.name && b.name !== cur.name
    ? await c.env.DB.prepare("SELECT 1 FROM people WHERE user_id = ? AND name = ? AND id <> ?").bind(user.id, b.name, id).first()
    : null;
  if (clash) return c.json({ error: "name_taken" }, 409);
  await c.env.DB.prepare("UPDATE people SET name = ?, archived = ? WHERE id = ? AND user_id = ?")
    .bind(b.name ?? cur.name, b.archived === undefined ? cur.archived : b.archived ? 1 : 0, id, user.id).run();
  return c.json({ ok: true });
});

peopleRoutes.get("/people/:id", async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const p = await person(db, user.id, idParam(c));
  const { results } = await db
    .prepare(
      `SELECT e.id, e.kind, e.cents, e.fecha, e.nota, e.movement_id, m.comercio, m.amount_cents AS movement_cents, m.fecha AS movement_fecha
       FROM person_entries e LEFT JOIN movements m ON m.id = e.movement_id AND m.user_id = e.user_id
       WHERE e.user_id = ? AND e.person_id = ? ORDER BY e.fecha DESC, e.id DESC LIMIT 300`,
    )
    .bind(user.id, p.id)
    .all<{ cents: number }>();
  const total = await db.prepare("SELECT COALESCE(SUM(cents), 0) AS n FROM person_entries WHERE user_id = ? AND person_id = ?").bind(user.id, p.id).first<{ n: number }>();
  return c.json({ person: { ...p, balance_cents: total?.n ?? 0 }, entries: results });
});

/** Her purchase, partly or wholly for this person: "paid_for" (all theirs) or "shared" (their part of a split).
 * Their part is what they owe her. A purchase's shares never add up to more than it cost. */
peopleRoutes.post("/people/:id/share", async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const p = await person(db, user.id, idParam(c));
  const b = await readBody(c, z.object({ movement_id: z.number().int().positive(), kind: z.enum(["paid_for", "shared"]), cents, nota }));
  const m = await getMovement(db, user.id, b.movement_id);
  if (!m) notFound();
  if (m.tipo !== "gasto") return c.json({ error: "invalid:movement" }, 400);
  const others = await db
    .prepare("SELECT COALESCE(SUM(cents), 0) AS n FROM person_entries WHERE user_id = ? AND movement_id = ? AND person_id <> ? AND kind IN ('paid_for', 'shared')")
    .bind(user.id, m.id, p.id)
    .first<{ n: number }>();
  if ((others?.n ?? 0) + b.cents > m.amount_cents) return c.json({ error: "invalid:cents" }, 400);
  await db
    .prepare(
      `INSERT INTO person_entries (user_id, person_id, movement_id, kind, cents, fecha, nota, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (person_id, movement_id) WHERE kind IN ('paid_for', 'shared') DO UPDATE SET kind = excluded.kind, cents = excluded.cents, nota = excluded.nota`,
    )
    .bind(user.id, p.id, m.id, b.kind, b.cents, m.fecha, b.nota, Date.now())
    .run();
  return c.json({ ok: true }, 201);
});

/** Someone paid for her: the purchase is her spending (a movement with no account of hers), and she owes it. */
peopleRoutes.post("/people/:id/they-paid", async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const p = await person(db, user.id, idParam(c));
  const b = await readBody(c, z.object({
    client_id: clientId, amount_cents: cents, fecha: fecha.optional(), comercio: z.string().trim().max(200).default(""),
    category_id: z.number().int().positive().nullable().optional(), nota,
  }));
  if (b.category_id) await assertOwned(db, "categories", b.category_id, user.id);
  const now = Date.now();
  const f = b.fecha ?? svNow(now).fecha;
  const dedupe = `manual:${b.client_id}`;
  // one write: the purchase and the line, each saved once however often the phone retries
  const [ins] = await db.batch([
    db.prepare(
      `INSERT INTO movements (user_id, fecha, hora, amount_cents, tipo, comercio, merchant_key, account_id, category_id, tags, nota,
         origen, estado, raw, dedupe_key, created_at, updated_at)
       VALUES (?, ?, NULL, ?, 'gasto', ?, ?, NULL, ?, '[]', ?, 'manual', ?, NULL, ?, ?, ?)
       ON CONFLICT (user_id, dedupe_key) DO NOTHING RETURNING *`,
    ).bind(user.id, f, b.amount_cents, b.comercio, merchantKey(b.comercio), b.category_id ?? null, b.nota,
      b.category_id ? "ok" : "revisar", dedupe, now, now),
    db.prepare(
      `INSERT INTO person_entries (user_id, person_id, movement_id, kind, cents, fecha, nota, client_id, created_at)
       SELECT ?, ?, id, 'they_paid', ?, ?, ?, ?, ? FROM movements WHERE user_id = ? AND dedupe_key = ?
       ON CONFLICT DO NOTHING`,
    ).bind(user.id, p.id, -b.amount_cents, f, b.nota, b.client_id, now, user.id, dedupe),
  ]);
  const m = ins!.results[0] as MovementRow | undefined;
  if (!m) return c.json({ duplicate: true });
  return c.json({ movement: publicMovement(m) }, 201);
});

/** "Saldar": money back from them (in) or to them (out). With an account, the transfer is kept as tipo interno on it,
 * which is never spending or income, so the month's numbers stay the same. */
peopleRoutes.post("/people/:id/settle", async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const p = await person(db, user.id, idParam(c));
  const b = await readBody(c, z.object({
    client_id: clientId, amount_cents: cents, direction: z.enum(["in", "out"]), account_id: z.number().int().positive().nullable().optional(),
    fecha: fecha.optional(), nota,
  }));
  if (b.account_id) await assertOwned(db, "accounts", b.account_id, user.id);
  const now = Date.now();
  const f = b.fecha ?? svNow(now).fecha;
  const dedupe = `manual:${b.client_id}`;
  const stmts: D1PreparedStatement[] = [];
  if (b.account_id) {
    stmts.push(db.prepare(
      `INSERT INTO movements (user_id, fecha, hora, amount_cents, tipo, comercio, merchant_key, account_id, category_id, tags, nota,
         origen, estado, raw, dedupe_key, created_at, updated_at)
       VALUES (?, ?, NULL, ?, 'interno', ?, '', ?, NULL, '[]', ?, 'manual', 'ok', NULL, ?, ?, ?) ON CONFLICT (user_id, dedupe_key) DO NOTHING`,
    ).bind(user.id, f, b.amount_cents, (b.direction === "in" ? "Saldo de " : "Saldo a ") + p.name, b.account_id, b.nota, dedupe, now, now));
  }
  stmts.push(db.prepare(
    `INSERT INTO person_entries (user_id, person_id, movement_id, kind, cents, fecha, nota, client_id, created_at)
     VALUES (?, ?, (SELECT id FROM movements WHERE user_id = ? AND dedupe_key = ?), 'settle', ?, ?, ?, ?, ?)
     ON CONFLICT DO NOTHING RETURNING id, movement_id`,
  ).bind(user.id, p.id, user.id, dedupe, b.direction === "in" ? -b.amount_cents : b.amount_cents, f, b.nota, b.client_id, now));
  const out = await db.batch(stmts);
  const row = out[out.length - 1]!.results[0] as { id: number; movement_id: number | null } | undefined;
  if (!row) return c.json({ duplicate: true });
  return c.json({ ok: true, movement_id: row.movement_id }, 201);
});

/** Remove one line. A movement the line made (they paid, a settle-up) goes with it, unless an import uses it. */
peopleRoutes.delete("/people/:id/entries/:eid", async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const p = await person(db, user.id, idParam(c));
  const eid = Number(c.req.param("eid"));
  if (!Number.isSafeInteger(eid) || eid <= 0) notFound();
  const e = await db.prepare("SELECT id, kind, movement_id FROM person_entries WHERE id = ? AND user_id = ? AND person_id = ?")
    .bind(eid, user.id, p.id).first<{ id: number; kind: string; movement_id: number | null }>();
  if (!e) notFound();
  const stmts = [db.prepare("DELETE FROM person_entries WHERE id = ? AND user_id = ?").bind(e.id, user.id)];
  if ((e.kind === "they_paid" || e.kind === "settle") && e.movement_id) {
    stmts.push(db.prepare(
      `DELETE FROM movements WHERE id = ? AND user_id = ? AND origen = 'manual'
       AND NOT EXISTS (SELECT 1 FROM import_rows WHERE movement_id = ? AND user_id = ?)
       AND NOT EXISTS (SELECT 1 FROM person_entries WHERE movement_id = ? AND user_id = ? AND id <> ?)`,
    ).bind(e.movement_id, user.id, e.movement_id, user.id, e.movement_id, user.id, e.id));
  }
  await db.batch(stmts);
  return c.json({ ok: true });
});

/** The people a purchase is shared with (the movement sheet). */
peopleRoutes.get("/people/movement/:id", async (c) => {
  const user = c.get("user");
  const m = await getMovement(c.env.DB, user.id, idParam(c));
  if (!m) notFound();
  const { results } = await c.env.DB
    .prepare(
      `SELECT e.id, e.person_id, p.name, e.kind, e.cents FROM person_entries e JOIN people p ON p.id = e.person_id
       WHERE e.user_id = ? AND e.movement_id = ? ORDER BY e.id`,
    )
    .bind(user.id, m.id)
    .all();
  return c.json({ shares: results });
});
