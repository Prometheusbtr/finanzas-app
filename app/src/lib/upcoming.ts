// Recurrentes: when each fixed payment falls, which real charge paid it, and what is still to come this month.
// Nothing is ever written by this: a payment counts against the month only until its real charge arrives.
import { monthBounds, shiftDays } from "./dates.ts";
import { daysBetween } from "./cards.ts";

export const EVERY = ["week", "2weeks", "month", "year"] as const;
export type Every = (typeof EVERY)[number];

export type RecurringRow = {
  id: number;
  name: string;
  merchant_key: string;
  amount_cents: number;
  every: Every;
  next_date: string;
  account_id: number | null;
  category_id: number | null;
  active: number;
};

export type Charge = { id: number; fecha: string; amount_cents: number; merchant_key: string; category_id: number | null; account_id?: number | null };

/** How far a real charge may land from its expected date and still be the same payment. */
export function windowDays(every: Every): number {
  return every === "week" ? 2 : every === "2weeks" ? 3 : 7;
}

function addMonths(anchor: string, months: number): string {
  const y = Number(anchor.slice(0, 4));
  const m = Number(anchor.slice(5, 7)) - 1 + months;
  const yy = y + Math.floor(m / 12);
  const mm = ((m % 12) + 12) % 12;
  const last = new Date(Date.UTC(yy, mm + 1, 0)).getUTCDate();
  const d = Math.min(Number(anchor.slice(8, 10)), last);
  return `${yy}-${String(mm + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Every date the payment falls on between `from` and `to` (both included), from its next date on: she said that
 * is the next one, so nothing before it is due. */
export function occurrences(r: Pick<RecurringRow, "every" | "next_date">, fromDate: string, to: string): string[] {
  const out: string[] = [];
  const from = fromDate > r.next_date ? fromDate : r.next_date;
  if (r.every === "week" || r.every === "2weeks") {
    const step = r.every === "week" ? 7 : 14;
    const k0 = Math.ceil(daysBetween(r.next_date, from) / step);
    for (let k = k0; ; k++) {
      const d = shiftDays(r.next_date, k * step);
      if (d > to) break;
      out.push(d);
    }
    return out;
  }
  const step = r.every === "month" ? 1 : 12;
  const span = Math.ceil(daysBetween(r.next_date, from) / (step * 31)) - 1;
  for (let k = span; k < span + 40; k++) {
    const d = addMonths(r.next_date, k * step);
    if (d > to) break;
    if (d >= from) out.push(d);
  }
  return out;
}

/** Is this charge the payment? Same shop (amount within 25%), or the same category with nearly the same amount. */
export function looksLike(r: RecurringRow, m: Charge): boolean {
  // F13: a payment tied to an account (a card, the bank) is paid only by a charge on that account
  if (r.account_id != null && m.account_id !== undefined && m.account_id !== r.account_id) return false;
  const near = (pct: number) => Math.abs(m.amount_cents - r.amount_cents) <= Math.max(r.amount_cents * pct, 100);
  const a = r.merchant_key;
  const b = m.merchant_key;
  if (a && b && a.length >= 3 && b.length >= 3 && (a === b || b.startsWith(a + " ") || a.startsWith(b + " "))) return near(0.25);
  return r.category_id != null && m.category_id === r.category_id && near(0.1);
}

export type Occurrence = { recurring_id: number; fecha: string; amount_cents: number; paid_by: number | null };

/** Each date of each payment between `from` and `to`, with the charge that paid it (each charge pays one date). */
export function matchOccurrences(rules: RecurringRow[], charges: Charge[], from: string, to: string): Occurrence[] {
  const used = new Set<number>();
  const all: (Occurrence & { rule: RecurringRow })[] = [];
  for (const r of rules) if (r.active) for (const f of occurrences(r, from, to)) all.push({ recurring_id: r.id, fecha: f, amount_cents: r.amount_cents, paid_by: null, rule: r });
  all.sort((x, y) => (x.fecha < y.fecha ? -1 : x.fecha > y.fecha ? 1 : x.recurring_id - y.recurring_id));
  for (const o of all) {
    const w = windowDays(o.rule.every);
    let best: Charge | null = null;
    for (const m of charges) {
      if (used.has(m.id) || !looksLike(o.rule, m)) continue;
      const gap = Math.abs(daysBetween(o.fecha, m.fecha));
      if (gap > w) continue;
      if (!best || gap < Math.abs(daysBetween(o.fecha, best.fecha))) best = m;
    }
    if (best) {
      used.add(best.id);
      o.paid_by = best.id;
    }
  }
  return all.map(({ rule: _r, ...o }) => o);
}

export type MonthPlan = {
  /** this month's dates not paid yet, from a week ago on: they will still come */
  pending: Occurrence[];
  /** pending money in all groups, and in groups that have a limit (what "Te quedan" takes off) */
  committed_cents: number;
  committed_limited_cents: number;
  upcoming: Occurrence[]; // today to 14 days ahead, not paid yet
};

/** What is still to come: the current month only (a past month is final; a future one has nothing spent yet). */
export async function monthPlan(db: D1Database, userId: number, today: string, month: string): Promise<MonthPlan> {
  const empty: MonthPlan = { pending: [], committed_cents: 0, committed_limited_cents: 0, upcoming: [] };
  const [rulesR, limitedR] = await db.batch([
    db.prepare(
      `SELECT id, name, merchant_key, amount_cents, every, next_date, account_id, category_id, active
       FROM recurring WHERE user_id = ? AND active = 1`,
    ).bind(userId),
    // categories inside a group that has a limit (the group's own or its categories' sum), as /summary counts them
    db.prepare(
      `SELECT c.id FROM categories c JOIN groups g ON g.id = c.group_id
       WHERE c.user_id = ? AND g.archived = 0 AND (g.limit_cents IS NOT NULL OR EXISTS (
         SELECT 1 FROM categories c2 WHERE c2.group_id = g.id AND c2.limit_cents IS NOT NULL))`,
    ).bind(userId),
  ]);
  const rules = rulesR.results as RecurringRow[];
  if (!rules.length) return empty;
  const b = monthBounds(month);
  const from = shiftDays(b.start, -7);
  const to = shiftDays(today, 21) > b.end ? shiftDays(today, 21) : b.end;
  const { results: charges } = await db
    .prepare(
      `SELECT id, fecha, amount_cents, merchant_key, category_id, account_id FROM movements
       WHERE user_id = ? AND tipo = 'gasto' AND fecha BETWEEN ? AND ?`,
    )
    .bind(userId, shiftDays(from, -7), shiftDays(to, 7))
    .all<Charge>();
  const occ = matchOccurrences(rules, charges, from, to);
  const limited = new Set((limitedR.results as { id: number }[]).map((r) => r.id));
  const catOf = new Map(rules.map((r) => [r.id, r.category_id]));
  const isCurrent = today.slice(0, 7) === month;
  const pending = isCurrent
    ? occ.filter((o) => o.paid_by == null && o.fecha >= b.start && o.fecha <= b.end && o.fecha >= shiftDays(today, -7))
    : [];
  const sum = (xs: Occurrence[]) => xs.reduce((s, o) => s + o.amount_cents, 0);
  return {
    pending,
    committed_cents: sum(pending),
    committed_limited_cents: sum(pending.filter((o) => limited.has(catOf.get(o.recurring_id) ?? -1))),
    upcoming: occ.filter((o) => o.paid_by == null && o.fecha >= today && o.fecha <= shiftDays(today, 14)),
  };
}

/** Days between repeats for each choice, as Importar's suggestions give them. */
export function everyFromDays(days: number): Every {
  return days <= 9 ? "week" : days <= 20 ? "2weeks" : days <= 200 ? "month" : "year";
}
