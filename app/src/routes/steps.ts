// "Primeros pasos": the per-person setup state. Rows are always this user's own (user_id from the session).
// Some steps are worked out from her data instead of stored: limits (any group with a monthly limit),
// statements (any movement from a statement or CSV) and lock (the Face ID lock is on).
import { Hono } from "hono";
import { z } from "zod";
import { DAY_MS, svNow } from "../lib/dates.ts";
import { notFound, readBody } from "../lib/http.ts";
import { BAC_EMAIL_READY, LIFE_MAP, LIMITS_AFTER_DAYS, STEP_AVAILABLE, STEP_STATES, STEPS, type StepId } from "../lib/steps.ts";
import type { AppEnv } from "../types.ts";

export const stepRoutes = new Hono<AppEnv>();

type Flags = {
  movements: number; first_fecha: string | null; has_limits: number; has_statements: number; has_bac: number; has_passkey: number; app_lock: number;
};

stepRoutes.get("/setup", async (c) => {
  const db = c.env.DB;
  const uid = c.get("user").id;
  const [rows, flags] = await db.batch([
    db.prepare("SELECT step, state, at, data FROM setup_steps WHERE user_id = ?").bind(uid),
    db.prepare(
      `SELECT (SELECT COUNT(*) FROM movements WHERE user_id = ?1) AS movements,
         (SELECT MIN(fecha) FROM movements WHERE user_id = ?1) AS first_fecha,
         EXISTS (SELECT 1 FROM groups WHERE user_id = ?1 AND limit_cents > 0) AS has_limits,
         EXISTS (SELECT 1 FROM movements WHERE user_id = ?1 AND (origen LIKE 'estado%' OR origen IN ('CSV', 'archivo CSV'))) AS has_statements,
         EXISTS (SELECT 1 FROM accounts WHERE user_id = ?1 AND archived = 0 AND name LIKE 'BAC%') AS has_bac,
         EXISTS (SELECT 1 FROM passkeys WHERE user_id = ?1) AS has_passkey,
         (SELECT app_lock FROM users WHERE id = ?1) AS app_lock`,
    ).bind(uid),
  ]);
  const stored = new Map((rows.results as { step: string; state: string; at: number; data: string }[]).map((r) => [r.step, r]));
  const f = flags.results[0] as Flags;
  const today = svNow().fecha;
  const dataDays = f.first_fecha ? Math.max(0, Math.round((Date.parse(today) - Date.parse(f.first_fecha)) / DAY_MS)) : 0;
  const derived: Partial<Record<StepId, boolean>> = { limits: f.has_limits === 1, statements: f.has_statements === 1, lock: f.app_lock === 1 };
  const steps = STEPS.map((id) => {
    const r = stored.get(id);
    const state = derived[id] ? "done" : r?.state ?? "open";
    return {
      id, state, at: r?.at ?? null,
      available: STEP_AVAILABLE[id],
      applies: id === "bac_email" ? BAC_EMAIL_READY && f.has_bac === 1 : true,
    };
  });
  let life: Record<string, boolean> = {};
  try {
    life = JSON.parse(stored.get("life")?.data ?? "{}");
  } catch {}
  const limits = steps.find((s) => s.id === "limits")!;
  return c.json({
    card: stored.get("card")?.state === "hidden" ? "hidden" : "open",
    steps,
    life,
    has_movements: f.movements > 0,
    data_days: dataDays,
    // After Importar's "Esperar un mes": a month of data, so offer limits from her own spending.
    limits_ready: limits.state === "waiting" && dataDays >= LIMITS_AFTER_DAYS,
    bac_email_ready: BAC_EMAIL_READY,
    has_bac: f.has_bac === 1,
    has_passkey: f.has_passkey === 1,
    app_lock: f.app_lock === 1,
  });
});

const upsert = (db: D1Database, uid: number, step: string, state: string, now: number) =>
  db.prepare(
    `INSERT INTO setup_steps (user_id, step, state, at) VALUES (?, ?, ?, ?)
     ON CONFLICT (user_id, step) DO UPDATE SET state = excluded.state, at = excluded.at`,
  ).bind(uid, step, state, now);

stepRoutes.put("/setup/steps/:step", async (c) => {
  const step = c.req.param("step");
  if (!(STEPS as readonly string[]).includes(step)) notFound();
  const { state } = await readBody(c, z.object({ state: z.enum(STEP_STATES) }));
  await upsert(c.env.DB, c.get("user").id, step, state, Date.now()).run();
  return c.json({ ok: true, step, state });
});

/** Hide the card, or show it again (Ajustes → Primeros pasos). */
stepRoutes.put("/setup/card", async (c) => {
  const { hidden } = await readBody(c, z.object({ hidden: z.boolean() }));
  await upsert(c.env.DB, c.get("user").id, "card", hidden ? "hidden" : "open", Date.now()).run();
  return c.json({ ok: true, card: hidden ? "hidden" : "open" });
});

const LifeSchema = z.object(Object.fromEntries(Object.keys(LIFE_MAP).map((k) => [k, z.boolean()])) as Record<string, z.ZodBoolean>);

// "Tu vida": a yes shows the matching starter groups and categories, a no archives them (nothing is deleted).
// One batch; only her own rows (user_id) are touched. The answers are kept with the step.
stepRoutes.post("/setup/life", async (c) => {
  const db = c.env.DB;
  const uid = c.get("user").id;
  const { answers } = await readBody(c, z.object({ answers: LifeSchema }));
  const stmts: D1PreparedStatement[] = [];
  for (const [q, yes] of Object.entries(answers)) {
    const m = LIFE_MAP[q];
    for (const g of m.groups ?? []) stmts.push(db.prepare("UPDATE groups SET archived = ? WHERE user_id = ? AND name = ?").bind(yes ? 0 : 1, uid, g));
    for (const n of m.categories ?? []) stmts.push(db.prepare("UPDATE categories SET archived = ? WHERE user_id = ? AND name = ?").bind(yes ? 0 : 1, uid, n));
  }
  stmts.push(db.prepare(
    `INSERT INTO setup_steps (user_id, step, state, at, data) VALUES (?, 'life', 'open', ?, ?)
     ON CONFLICT (user_id, step) DO UPDATE SET data = excluded.data`,
  ).bind(uid, Date.now(), JSON.stringify(answers)));
  await db.batch(stmts);
  return c.json({ ok: true, answers });
});
