import { Hono } from "hono";
import { z } from "zod";
import { isValidMonth, monthBounds, shiftDays, svNow } from "../lib/dates.ts";
import { readBody } from "../lib/http.ts";
import { MAX_CENTS } from "../lib/money.ts";
import { type BudgetPrefs, derivedNow, loadBudget } from "../lib/week.ts";
import type { AppEnv } from "../types.ts";
import { type ResetRow, resetHistory, resetView } from "./account.ts";

export const summaryRoutes = new Hono<AppEnv>();

type GroupRow = { id: number; name: string; sort: number; limit_cents: number | null; archived: number };
type CategoryRow = { id: number; group_id: number; name: string; kind: string; limit_cents: number | null; sort: number; archived: number };
type AccountRow = { id: number; name: string; kind: string; sort: number; archived: number };

/** Everything the app needs on start, in one call. */
summaryRoutes.get("/bootstrap", async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const today = svNow().fecha;
  const [groups, cats, accounts, top, lastAcc, review, lastBank, resets, budget] = await db.batch([
    db.prepare("SELECT id, name, sort, limit_cents, archived FROM groups WHERE user_id = ? ORDER BY sort, id").bind(user.id),
    db.prepare("SELECT id, group_id, name, kind, limit_cents, sort, archived FROM categories WHERE user_id = ? ORDER BY sort, id").bind(user.id),
    db.prepare("SELECT id, name, kind, sort, archived FROM accounts WHERE user_id = ? ORDER BY sort, id").bind(user.id),
    db.prepare(
      `SELECT m.category_id AS id, COUNT(*) AS n FROM movements m JOIN categories c ON c.id = m.category_id
       WHERE m.user_id = ? AND m.tipo = 'gasto' AND m.fecha >= ? AND c.archived = 0
       GROUP BY m.category_id ORDER BY n DESC LIMIT 12`,
    ).bind(user.id, shiftDays(today, -90)),
    db.prepare(
      `SELECT account_id FROM movements WHERE user_id = ? AND origen = 'manual' AND account_id IS NOT NULL
       ORDER BY created_at DESC LIMIT 1`,
    ).bind(user.id),
    db.prepare("SELECT COUNT(*) AS n FROM movements WHERE user_id = ? AND estado = 'revisar'").bind(user.id),
    db.prepare(
      `SELECT fecha, hora FROM movements WHERE user_id = ? AND origen = 'correo BAC'
       ORDER BY fecha DESC, COALESCE(hora, '') DESC LIMIT 1`,
    ).bind(user.id),
    // a Face ID reset link for her that has not been used: Home and Mi cuenta show it with "Cancelar"
    resetHistory(db, user.id, true),
    // weekly "Te quedan": no row = per month (Feature 3)
    db.prepare("SELECT period, week_cents, week_start FROM budget_prefs WHERE user_id = ?").bind(user.id),
  ]);
  const now = Date.now();
  return c.json({
    user,
    today,
    reset_pending: (resets.results as ResetRow[]).map((r) => resetView(r, now)),
    groups: groups.results as GroupRow[],
    categories: cats.results as CategoryRow[],
    accounts: accounts.results as AccountRow[],
    top_categories: (top.results as { id: number }[]).map((r) => r.id),
    last_account_id: (lastAcc.results[0] as { account_id: number } | undefined)?.account_id ?? null,
    review_count: (review.results[0] as { n: number }).n,
    last_bac: (lastBank.results[0] as { fecha: string; hora: string | null } | undefined) ?? null,
    budget: (budget.results[0] as BudgetPrefs | undefined) ?? { period: "month", week_cents: null, week_start: 1 },
  });
});

/** Ajustes → Tu presupuesto: how "Te quedan" counts, plus what a week is worth from her limits (the hint). */
summaryRoutes.get("/me/budget", async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const prefs = await loadBudget(db, user.id);
  return c.json({ ...prefs, derived_week_cents: await derivedNow(db, user.id, svNow().fecha, prefs.week_start) });
});

const BudgetBody = z.object({
  period: z.enum(["month", "week"]),
  week_cents: z.number().int().min(0).max(MAX_CENTS).nullable(),
  week_start: z.number().int().min(0).max(6),
}).strict();

summaryRoutes.put("/me/budget", async (c) => {
  const user = c.get("user");
  const b = await readBody(c, BudgetBody);
  await c.env.DB
    .prepare(
      `INSERT INTO budget_prefs (user_id, period, week_cents, week_start, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET period = excluded.period, week_cents = excluded.week_cents,
         week_start = excluded.week_start, updated_at = excluded.updated_at`,
    )
    .bind(user.id, b.period, b.week_cents, b.week_start, Date.now())
    .run();
  return c.json({ budget: { period: b.period, week_cents: b.week_cents, week_start: b.week_start } });
});

/** Spending for one month by group and category, against the limits. Only gasto counts; abono subtracts. */
summaryRoutes.get("/summary", async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const now = svNow();
  const month = isValidMonth(c.req.query("month") ?? "") ? c.req.query("month")! : now.fecha.slice(0, 7);
  const b = monthBounds(month);
  const [spent, income, groups, cats, review] = await db.batch([
    db.prepare(
      `SELECT category_id, SUM(CASE tipo WHEN 'gasto' THEN amount_cents ELSE -amount_cents END) AS cents, COUNT(*) AS n
       FROM movements WHERE user_id = ? AND fecha BETWEEN ? AND ? AND tipo IN ('gasto', 'abono')
       GROUP BY category_id`,
    ).bind(user.id, b.start, b.end),
    db.prepare(
      "SELECT COALESCE(SUM(amount_cents), 0) AS cents FROM movements WHERE user_id = ? AND fecha BETWEEN ? AND ? AND tipo = 'ingreso'",
    ).bind(user.id, b.start, b.end),
    db.prepare("SELECT id, name, sort, limit_cents, archived FROM groups WHERE user_id = ? ORDER BY sort, id").bind(user.id),
    db.prepare("SELECT id, group_id, name, kind, limit_cents, sort, archived FROM categories WHERE user_id = ? ORDER BY sort, id").bind(user.id),
    db.prepare("SELECT COUNT(*) AS n FROM movements WHERE user_id = ? AND estado = 'revisar'").bind(user.id),
  ]);

  const byCat = new Map<number | null, number>();
  for (const r of spent.results as { category_id: number | null; cents: number }[]) byCat.set(r.category_id, r.cents);
  const kinds: Record<string, number> = { E: 0, G: 0, A: 0, M: 0 };
  const outGroups = (groups.results as GroupRow[]).map((g) => {
    const gc = (cats.results as CategoryRow[]).filter((x) => x.group_id === g.id).map((x) => {
      const cents = byCat.get(x.id) ?? 0;
      kinds[x.kind] = (kinds[x.kind] ?? 0) + cents;
      return { id: x.id, name: x.name, kind: x.kind, limit_cents: x.limit_cents, archived: x.archived, spent_cents: cents };
    });
    const catLimits = gc.filter((x) => x.limit_cents != null).reduce((s, x) => s + (x.limit_cents ?? 0), 0);
    return {
      id: g.id, name: g.name, archived: g.archived,
      limit_cents: g.limit_cents ?? (catLimits || null),
      spent_cents: gc.reduce((s, x) => s + x.spent_cents, 0),
      cats: gc,
    };
  });
  const uncategorized = byCat.get(null) ?? 0;
  const spentTotal = outGroups.reduce((s, g) => s + g.spent_cents, 0) + uncategorized;
  const limitTotal = outGroups.filter((g) => !g.archived).reduce((s, g) => s + (g.limit_cents ?? 0), 0);
  const isCurrent = month === now.fecha.slice(0, 7);
  const isPast = month < now.fecha.slice(0, 7);
  const day = isCurrent ? Number(now.fecha.slice(8, 10)) : isPast ? b.days : 0;

  return c.json({
    month, today: now.fecha, day, days: b.days,
    spent_cents: spentTotal,
    limit_cents: limitTotal,
    // limited_spent_cents: spending inside groups that have a limit, so the pace bar compares like with like
    limited_spent_cents: outGroups.filter((g) => g.limit_cents != null && !g.archived).reduce((s, g) => s + g.spent_cents, 0),
    income_cents: (income.results[0] as { cents: number }).cents,
    uncategorized_cents: uncategorized,
    by_kind: kinds,
    groups: outGroups,
    review_count: (review.results[0] as { n: number }).n,
  });
});
