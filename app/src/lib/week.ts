// Weekly "Te quedan" (Feature 3, Nov 2026). Pure date math plus one read of the week's spending.
// Group and category limits stay monthly; only Home's big number can count per week. With no budget_prefs row
// (or period 'month') nothing here runs, so the monthly numbers never change.
import { monthBounds, shiftDays } from "./dates.ts";
import { type Charge, matchOccurrences, occurrences, type RecurringRow } from "./upcoming.ts";

export type BudgetPrefs = { period: "month" | "week"; week_cents: number | null; week_start: number };
export const DEFAULT_BUDGET: BudgetPrefs = { period: "month", week_cents: null, week_start: 1 };

export async function loadBudget(db: D1Database, userId: number): Promise<BudgetPrefs> {
  const r = await db.prepare("SELECT period, week_cents, week_start FROM budget_prefs WHERE user_id = ?").bind(userId).first<BudgetPrefs>();
  return r ?? { ...DEFAULT_BUDGET };
}

/** The week that holds `today`, starting on weekday `start` (0 = Sunday). `day` is 1..7 (today counts). */
export function weekBounds(today: string, start: number): { start: string; end: string; day: number } {
  const dow = new Date(today + "T00:00:00Z").getUTCDay();
  const back = (dow - start + 7) % 7;
  const s = shiftDays(today, -back);
  return { start: s, end: shiftDays(s, 6), day: back + 1 };
}

/** Each date from `from` to `to`, both included. */
function days(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = shiftDays(d, 1)) out.push(d);
  return out;
}

type Limits = { total: number; cats: Set<number> };

/** The monthly limit total and the categories it covers, counted as /summary counts them. */
async function limits(db: D1Database, userId: number): Promise<Limits> {
  const [g, c] = await db.batch([
    db.prepare("SELECT id, limit_cents FROM groups WHERE user_id = ? AND archived = 0").bind(userId),
    db.prepare("SELECT id, group_id, limit_cents FROM categories WHERE user_id = ?").bind(userId),
  ]);
  const cats = c.results as { id: number; group_id: number; limit_cents: number | null }[];
  let total = 0;
  const covered = new Set<number>();
  for (const grp of g.results as { id: number; limit_cents: number | null }[]) {
    const mine = cats.filter((x) => x.group_id === grp.id);
    const lim = grp.limit_cents ?? (mine.filter((x) => x.limit_cents != null).reduce((s, x) => s + (x.limit_cents ?? 0), 0) || null);
    if (lim == null) continue;
    total += lim;
    for (const x of mine) covered.add(x.id);
  }
  return { total, cats: covered };
}

/** What a week is worth when she has not typed her own amount: each day gets its month's limits, less that
 * month's fixed payments in limited groups, divided by the month's days. A week across two months mixes them. */
export function derivedWeek(dates: string[], limitTotal: number, fixedByMonth: Map<string, number>): number | null {
  if (!limitTotal) return null;
  let sum = 0;
  for (const d of dates) {
    const m = d.slice(0, 7);
    sum += Math.max(0, limitTotal - (fixedByMonth.get(m) ?? 0)) / monthBounds(m).days;
  }
  return Math.max(0, Math.round(sum / 100) * 100); // whole dollars
}

export type WeekView = {
  start: string; end: string; day: number;
  budget_cents: number | null; from: "own" | "limits" | null;
  spent_cents: number;
  last: { budget_cents: number | null; spent_cents: number } | null;
};

/** This week (and last week) for Home: budget, spending without fixed payments, and last week's result. */
export async function weekView(db: D1Database, userId: number, today: string, prefs: BudgetPrefs): Promise<WeekView> {
  const wk = weekBounds(today, prefs.week_start);
  const lastStart = shiftDays(wk.start, -7);
  const lim = await limits(db, userId);
  const [rulesR, movR] = await db.batch([
    db.prepare(
      `SELECT id, name, merchant_key, amount_cents, every, next_date, account_id, category_id, active
       FROM recurring WHERE user_id = ? AND active = 1`,
    ).bind(userId),
    db.prepare(
      `SELECT id, fecha, amount_cents, tipo, merchant_key, category_id, account_id FROM movements
       WHERE user_id = ? AND tipo IN ('gasto', 'abono') AND fecha BETWEEN ? AND ?`,
    ).bind(userId, shiftDays(lastStart, -14), shiftDays(wk.end, 14)),
  ]);
  const rules = rulesR.results as RecurringRow[];
  const movs = movR.results as (Charge & { tipo: string })[];
  // fixed payments (Recurrentes) come out of the monthly pay, not the weekly money: the charges that paid one are left out
  const occ = matchOccurrences(rules, movs.filter((m) => m.tipo === "gasto"), shiftDays(lastStart, -7), shiftDays(wk.end, 7));
  const fixedIds = new Set(occ.map((o) => o.paid_by).filter((x): x is number => x != null));
  const counts = (m: { category_id: number | null }) => (lim.total ? m.category_id != null && lim.cats.has(m.category_id) : true);
  const spent = (from: string, to: string) =>
    movs.filter((m) => m.fecha >= from && m.fecha <= to && !fixedIds.has(m.id) && counts(m))
      .reduce((s, m) => s + (m.tipo === "gasto" ? m.amount_cents : -m.amount_cents), 0);
  // fixed payments in limited groups, per month the two weeks touch
  const fixedByMonth = new Map<string, number>();
  for (const m of new Set([lastStart.slice(0, 7), wk.end.slice(0, 7), wk.start.slice(0, 7)])) {
    const b = monthBounds(m);
    let n = 0;
    for (const r of rules) {
      if (r.category_id == null || !lim.cats.has(r.category_id)) continue;
      n += occurrences(r, b.start, b.end).length * r.amount_cents;
    }
    fixedByMonth.set(m, n);
  }
  const budgetFor = (from: string) =>
    prefs.week_cents != null ? prefs.week_cents : derivedWeek(days(from, shiftDays(from, 6)), lim.total, fixedByMonth);
  const budget = budgetFor(wk.start);
  return {
    start: wk.start, end: wk.end, day: wk.day,
    budget_cents: budget, from: prefs.week_cents != null ? "own" : budget != null ? "limits" : null,
    spent_cents: spent(wk.start, today),
    last: { budget_cents: budgetFor(lastStart), spent_cents: spent(lastStart, shiftDays(wk.start, -1)) },
  };
}

/** The Ajustes hint: what this week would be from her limits. */
export async function derivedNow(db: D1Database, userId: number, today: string, weekStart: number): Promise<number | null> {
  const v = await weekView(db, userId, today, { period: "week", week_cents: null, week_start: weekStart });
  return v.budget_cents;
}
