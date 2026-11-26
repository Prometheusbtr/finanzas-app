// Statement upload (Importar) and "Primeros pasos" steps 4 to 6. The phone reads the file; only rows come
// here, and every row is checked again: dates inside the statement period (7 days either side), amount
// limits, text lengths, invisible characters removed (readBody). The server builds the dedupe keys.

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { isAllowedFecha, isValidFecha, monthBounds, shiftDays, SV_OFFSET_MS, svNow } from "../lib/dates.ts";
import { idParam, notFound, readBody } from "../lib/http.ts";
import { type ImportRec, type InRow, previewChunk, refreshTotals, saveChunk, sortRows, undoImport } from "../lib/importing.ts";
import { MAX_CENTS } from "../lib/money.ts";
import { assertOwned } from "../lib/owned.ts";
import { fullMonths } from "../lib/plan.ts";
import { findRecurring, type SpendRow } from "../lib/recurring.ts";
import { type AppEnv, type MovementRow, publicMovement } from "../types.ts";

export const importRoutes = new Hono<AppEnv>();

export const IMPORT_LIMITS = {
  rowsPerRequest: 500,
  rowsPerDay: 5000,
  rowsPerImport: 2000,
  importsPerDay: 50,
  periodDays: 400,
  slackDays: 7,
  csvMaps: 50,
  recurringChoices: 200,
};
const SOURCES = ["bac_tc", "agricola_tc", "uglycash", "csv"] as const;

const fecha = z.string().refine(isValidFecha, "fecha");
const rowSchema = z.object({
  fecha,
  comercio: z.string().max(120).optional(),
  cents: z.number().int().min(1).max(MAX_CENTS),
  dir: z.enum(["out", "in"]),
  tipo: z.enum(["interno", "ingreso"]).nullable().optional(),
});
const rowsSchema = z.array(rowSchema).min(1).max(IMPORT_LIMITS.rowsPerRequest);
const periodSchema = { account_id: z.number().int().positive(), period_start: fecha, period_end: fecha };

/** Start of today in El Salvador, in ms (for the per-day row limit). */
function svDayStart(now = Date.now()): number {
  return Date.parse(svNow(now).fecha + "T00:00:00Z") - SV_OFFSET_MS;
}

function checkPeriod(start: string, end: string) {
  if (start > end || !isAllowedFecha(start) || !isAllowedFecha(end)) throw new HTTPException(400, { message: "invalid:period" });
  const span = (Date.parse(end) - Date.parse(start)) / 86_400_000;
  if (span > IMPORT_LIMITS.periodDays) throw new HTTPException(400, { message: "invalid:period" });
}

/** Every row's date must sit inside the statement period, 7 days either side, and not in the future. */
function checkRows(rows: InRow[], start: string, end: string) {
  const lo = shiftDays(start, -IMPORT_LIMITS.slackDays);
  const hi = shiftDays(end, IMPORT_LIMITS.slackDays);
  rows.forEach((r, i) => {
    if (r.fecha < lo || r.fecha > hi || !isAllowedFecha(r.fecha)) throw new HTTPException(400, { message: `invalid:rows.${i}.fecha` });
  });
}

async function getImport(db: D1Database, userId: number, id: number) {
  return db.prepare("SELECT * FROM imports WHERE id = ? AND user_id = ?").bind(id, userId).first<
    ImportRec & { status: string; parts: number; balanced: number; added: number; already: number; merged: number; review: number; created_at: number }
  >();
}

const publicImport = (r: Record<string, unknown>) => ({
  id: r.id, account_id: r.account_id, source: r.source, period_start: r.period_start, period_end: r.period_end,
  balanced: r.balanced === 1, added: r.added, already: r.already, merged: r.merged, review: r.review, status: r.status,
  created_at: r.created_at,
});

// ---------- preview, create, save, finish ----------

importRoutes.post("/imports/preview", async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const b = await readBody(c, z.object({ ...periodSchema, source: z.enum(SOURCES), rows: rowsSchema }));
  checkPeriod(b.period_start, b.period_end);
  await assertOwned(db, "accounts", b.account_id, user.id);
  checkRows(b.rows, b.period_start, b.period_end);
  return c.json(await previewChunk(db, user.id, b.account_id, b.source, sortRows(b.rows)));
});

importRoutes.post("/imports", async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const b = await readBody(c, z.object({ ...periodSchema, source: z.enum(SOURCES), balanced: z.boolean() }));
  checkPeriod(b.period_start, b.period_end);
  await assertOwned(db, "accounts", b.account_id, user.id);
  const today = await db.prepare("SELECT COUNT(*) AS n FROM imports WHERE user_id = ? AND created_at >= ?")
    .bind(user.id, svDayStart()).first<{ n: number }>();
  if ((today?.n ?? 0) >= IMPORT_LIMITS.importsPerDay) throw new HTTPException(429, { message: "limit:imports_per_day" });
  const now = Date.now();
  const r = await db
    .prepare(
      `INSERT INTO imports (user_id, account_id, source, period_start, period_end, balanced, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .bind(user.id, b.account_id, b.source, b.period_start, b.period_end, b.balanced ? 1 : 0, now, now)
    .first<{ id: number }>();
  return c.json({ id: r!.id }, 201);
});

importRoutes.post("/imports/:id/rows", async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const id = idParam(c);
  const imp = await getImport(db, user.id, id);
  if (!imp) notFound();
  const b = await readBody(c, z.object({ part: z.number().int().min(0).max(1000), rows: rowsSchema }));
  if (imp.status !== "open") throw new HTTPException(409, { message: "import_closed" });
  if (b.part < imp.parts) return c.json({ duplicate_part: true, totals: await refreshTotals(db, user.id, id) });
  if (b.part !== imp.parts) throw new HTTPException(409, { message: "part_order" });
  checkRows(b.rows, imp.period_start, imp.period_end);
  const [inImport, today] = await db.batch([
    db.prepare("SELECT COUNT(*) AS n FROM import_rows WHERE user_id = ? AND import_id = ?").bind(user.id, id),
    db.prepare("SELECT COUNT(*) AS n FROM import_rows WHERE user_id = ? AND created_at >= ?").bind(user.id, svDayStart()),
  ]);
  if ((inImport.results[0] as { n: number }).n + b.rows.length > IMPORT_LIMITS.rowsPerImport) {
    throw new HTTPException(413, { message: "limit:rows_per_import" });
  }
  if ((today.results[0] as { n: number }).n + b.rows.length > IMPORT_LIMITS.rowsPerDay) {
    throw new HTTPException(429, { message: "limit:rows_per_day" });
  }
  let saved;
  try {
    // One batch (a D1 transaction) claims the part and writes it, so "parts" moves only with the rows: a failed
    // part may be sent again to this same import, and a saved one never is saved twice.
    saved = await saveChunk(db, user.id, imp, sortRows(b.rows), b.part);
  } catch (e) {
    // Taken meanwhile (a copy sent at the same time, or D1 saved it and its answer was lost), or undone meanwhile.
    const now = await getImport(db, user.id, id);
    if (now && now.status !== "open") throw new HTTPException(409, { message: "import_closed" });
    if (now && b.part < now.parts) return c.json({ duplicate_part: true, totals: await refreshTotals(db, user.id, id) });
    throw e;
  }
  return c.json({ saved, totals: await refreshTotals(db, user.id, id) });
});

importRoutes.post("/imports/:id/finish", async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const id = idParam(c);
  const imp = await getImport(db, user.id, id);
  if (!imp) notFound();
  if (imp.status === "undone") throw new HTTPException(409, { message: "import_closed" });
  const totals = await refreshTotals(db, user.id, id);
  await db.prepare("UPDATE imports SET status = 'done', updated_at = ? WHERE id = ? AND user_id = ?").bind(Date.now(), id, user.id).run();
  return c.json({ id, totals });
});

importRoutes.post("/imports/:id/undo", async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const id = idParam(c);
  const imp = await getImport(db, user.id, id);
  if (!imp) notFound();
  if (imp.status === "undone") return c.json({ removed: 0, restored: 0, already_undone: true });
  return c.json(await undoImport(db, user.id, id));
});

// ---------- list, review ----------

importRoutes.get("/imports", async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const [list, cover] = await db.batch([
    db.prepare("SELECT * FROM imports WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 100").bind(user.id),
    db.prepare(
      `SELECT account_id, period_start, period_end FROM imports WHERE user_id = ? AND status = 'done' ORDER BY account_id, period_start`,
    ).bind(user.id),
  ]);
  // The months each account's statements cover (a month counts when a statement's period touches it).
  const months = new Map<number, Set<string>>();
  for (const r of cover.results as { account_id: number; period_start: string; period_end: string }[]) {
    const set = months.get(r.account_id) ?? new Set<string>();
    for (let m = r.period_start.slice(0, 7); m <= r.period_end.slice(0, 7); m = shiftDays(monthBounds(m).end, 1).slice(0, 7)) set.add(m);
    months.set(r.account_id, set);
  }
  return c.json({
    items: (list.results as Record<string, unknown>[]).map(publicImport),
    coverage: [...months].map(([account_id, s]) => ({ account_id, months: [...s].sort() })),
  });
});

/** Up to 10 new rows from this import that nothing knew how to sort ("Revisa 10 movimientos"). */
importRoutes.get("/imports/:id/review", async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const id = idParam(c);
  if (!(await getImport(db, user.id, id))) notFound();
  const { results } = await db
    .prepare(
      `SELECT m.* FROM import_rows ir JOIN movements m ON m.id = ir.movement_id AND m.user_id = ir.user_id
       WHERE ir.user_id = ? AND ir.import_id = ? AND ir.kind = 'added' AND m.estado = 'revisar' AND m.tipo IN ('gasto', 'abono')
         AND NOT EXISTS (SELECT 1 FROM merge_suggestions s WHERE s.user_id = m.user_id AND s.bank_id = m.id)
       ORDER BY m.amount_cents DESC, m.id LIMIT 10`,
    )
    .bind(user.id, id)
    .all<MovementRow>();
  return c.json({ items: results.map(publicMovement) });
});

// ---------- fixed payments ----------

async function recurringNow(db: D1Database, userId: number) {
  const since = shiftDays(svNow().fecha, -120);
  const { results } = await db
    .prepare("SELECT merchant_key, comercio, fecha, amount_cents FROM movements WHERE user_id = ? AND tipo = 'gasto' AND fecha >= ?")
    .bind(userId, since)
    .all<SpendRow>();
  return findRecurring(results);
}

importRoutes.get("/imports/recurring", async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const [found, choices] = await Promise.all([
    recurringNow(db, user.id),
    db.prepare("SELECT merchant_key, keep FROM recurring_choices WHERE user_id = ?").bind(user.id).all<{ merchant_key: string; keep: number }>(),
  ]);
  const chosen = new Map(choices.results.map((r) => [r.merchant_key, r.keep === 1]));
  return c.json({ items: found.map((r) => ({ ...r, keep: chosen.has(r.merchant_key) ? chosen.get(r.merchant_key) : null })) });
});

importRoutes.post("/imports/recurring", async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const b = await readBody(c, z.object({ merchant_key: z.string().min(1).max(80), keep: z.boolean() }));
  const hit = (await recurringNow(db, user.id)).find((r) => r.merchant_key === b.merchant_key);
  if (!hit) notFound();
  const n = await db.prepare("SELECT COUNT(*) AS n FROM recurring_choices WHERE user_id = ? AND merchant_key <> ?")
    .bind(user.id, b.merchant_key).first<{ n: number }>();
  if ((n?.n ?? 0) >= IMPORT_LIMITS.recurringChoices) throw new HTTPException(429, { message: "limit:recurring" });
  await db
    .prepare(
      `INSERT INTO recurring_choices (user_id, merchant_key, keep, amount_cents, every_days, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id, merchant_key) DO UPDATE SET keep = excluded.keep, amount_cents = excluded.amount_cents,
         every_days = excluded.every_days, updated_at = excluded.updated_at`,
    )
    .bind(user.id, b.merchant_key, b.keep ? 1 : 0, hit.amount_cents, hit.every_days, Date.now())
    .run();
  return c.json({ ok: true });
});

// ---------- CSV column maps (per bank file layout) ----------

const sigParam = (s: string | undefined) => {
  if (!s || !/^[0-9a-f]{32}$/.test(s)) notFound();
  return s;
};
const csvMapSchema = z.object({
  fecha: z.number().int().min(0).max(60),
  comercio: z.number().int().min(0).max(60).nullable(),
  monto: z.number().int().min(0).max(60).nullable(),
  cargo: z.number().int().min(0).max(60).nullable(),
  abono: z.number().int().min(0).max(60).nullable(),
  saldo: z.number().int().min(0).max(60).nullable(),
  order: z.enum(["dmy", "mdy", "ymd"]),
  sign: z.enum(["out_positive", "out_negative"]),
});

importRoutes.get("/imports/csv-maps/:sig", async (c) => {
  const user = c.get("user");
  const sig = sigParam(c.req.param("sig"));
  const r = await c.env.DB.prepare("SELECT account_id, map FROM import_csv_maps WHERE user_id = ? AND header_sig = ?")
    .bind(user.id, sig).first<{ account_id: number | null; map: string }>();
  // No saved map yet is the normal first time, not an error (and no 404 line in the browser console).
  if (!r) return c.json({ account_id: null, map: null });
  return c.json({ account_id: r.account_id, map: JSON.parse(r.map) });
});

importRoutes.put("/imports/csv-maps/:sig", async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const sig = sigParam(c.req.param("sig"));
  const b = await readBody(c, z.object({ account_id: z.number().int().positive().nullable(), map: csvMapSchema }));
  if (b.account_id != null) await assertOwned(db, "accounts", b.account_id, user.id);
  const n = await db.prepare("SELECT COUNT(*) AS n FROM import_csv_maps WHERE user_id = ? AND header_sig <> ?")
    .bind(user.id, sig).first<{ n: number }>();
  if ((n?.n ?? 0) >= IMPORT_LIMITS.csvMaps) throw new HTTPException(429, { message: "limit:csv_maps" });
  await db
    .prepare(
      `INSERT INTO import_csv_maps (user_id, header_sig, account_id, map, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (user_id, header_sig) DO UPDATE SET account_id = excluded.account_id, map = excluded.map, updated_at = excluded.updated_at`,
    )
    .bind(user.id, sig, b.account_id, JSON.stringify(b.map), Date.now())
    .run();
  return c.json({ ok: true });
});

// ---------- Primeros pasos: savings (step 5) and averages for limits (step 6) ----------

importRoutes.get("/pasos", async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const today = svNow().fecha;
  const [first, savings, groups, cats, withData] = await db.batch([
    db.prepare("SELECT MIN(fecha) AS f FROM movements WHERE user_id = ? AND tipo IN ('gasto', 'abono', 'ingreso')").bind(user.id),
    db.prepare("SELECT amount_cents FROM savings_plan WHERE user_id = ?").bind(user.id),
    db.prepare("SELECT id, name, limit_cents, archived FROM groups WHERE user_id = ? ORDER BY sort, id").bind(user.id),
    db.prepare("SELECT id, group_id, limit_cents FROM categories WHERE user_id = ?").bind(user.id),
    db.prepare("SELECT DISTINCT substr(fecha, 1, 7) AS ym FROM movements WHERE user_id = ? AND fecha >= ? AND tipo IN ('gasto', 'abono', 'ingreso')")
      .bind(user.id, shiftDays(today, -400)),
  ]);
  // F41: the averages use the last 3 full months that have rows; a month with no data (a gap between statements)
  // is not counted as a month of $0.
  const has = new Set((withData.results as { ym: string }[]).map((r) => r.ym));
  const months = fullMonths((first.results[0] as { f: string | null }).f, today, 12).filter((m) => has.has(m)).slice(-3);
  const gs = (groups.results as { id: number; name: string; limit_cents: number | null; archived: number }[]).filter((g) => !g.archived);
  const cs = cats.results as { id: number; group_id: number; limit_cents: number | null }[];
  const spentBy = new Map<number, number>();
  let income: number | null = null;
  if (months.length) {
    const start = `${months[0]}-01`;
    const end = monthBounds(months[months.length - 1]).end;
    // Same spending rule as summary.ts: gasto counts, abono subtracts, by the row's category.
    const [spent, inc] = await db.batch([
      db.prepare(
        `SELECT c.group_id AS g, SUM(CASE m.tipo WHEN 'gasto' THEN m.amount_cents ELSE -m.amount_cents END) AS cents
         FROM movements m JOIN categories c ON c.id = m.category_id
         WHERE m.user_id = ? AND m.fecha BETWEEN ? AND ? AND m.tipo IN ('gasto', 'abono') GROUP BY c.group_id`,
      ).bind(user.id, start, end),
      db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents), 0) AS cents FROM movements WHERE user_id = ? AND fecha BETWEEN ? AND ? AND tipo = 'ingreso'")
        .bind(user.id, start, end),
    ]);
    for (const r of spent.results as { g: number; cents: number }[]) spentBy.set(r.g, r.cents);
    const i = inc.results[0] as { n: number; cents: number };
    if (i.n > 0) income = Math.round(i.cents / months.length);
  }
  const out = gs.map((g) => {
    const catLimits = cs.filter((x) => x.group_id === g.id && x.limit_cents != null).reduce((s, x) => s + (x.limit_cents ?? 0), 0);
    return {
      id: g.id, name: g.name, limit_cents: g.limit_cents ?? (catLimits || null),
      avg_cents: months.length ? Math.max(0, Math.round((spentBy.get(g.id) ?? 0) / months.length)) : null,
    };
  });
  return c.json({
    months,
    savings_cents: (savings.results[0] as { amount_cents: number } | undefined)?.amount_cents ?? null,
    income_avg_cents: income,
    limits_sum_cents: out.reduce((s, g) => s + (g.limit_cents ?? 0), 0),
    groups: out,
  });
});

importRoutes.put("/pasos/savings", async (c) => {
  const user = c.get("user");
  const b = await readBody(c, z.object({ amount_cents: z.number().int().min(0).max(MAX_CENTS) }));
  await c.env.DB.prepare(
    `INSERT INTO savings_plan (user_id, amount_cents, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET amount_cents = excluded.amount_cents, updated_at = excluded.updated_at`,
  ).bind(user.id, b.amount_cents, Date.now()).run();
  return c.json({ ok: true, amount_cents: b.amount_cents });
});
