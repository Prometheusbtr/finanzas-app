// Tarjetas: closing day, due day and limit per card account, and the dates the evening reminder works from.
import { shiftDays } from "./dates.ts";

export type CardRow = {
  account_id: number;
  name: string;
  closing_day: number | null;
  due_day: number | null;
  limit_cents: number | null;
  st_id: number | null; // that statement's row, so a typed correction replaces it instead of adding a second one
  st_closing: string | null; // latest statement we know of (email, typed)
  st_due: string | null;
  st_min: number | null;
  st_full: number | null;
  imp_closing: string | null; // latest imported statement's last day
};

const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** The date with this day of the month on or after `from` (day 31 in a 30-day month is the 30th). */
export function nextDayOfMonth(from: string, day: number): string {
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(5, 7));
  for (let i = 0; i < 2; i++) {
    const d = Math.min(day, daysIn(y, m));
    const f = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    if (f >= from) return f;
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return from; // unreachable: the next month always has the day
}

export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** Every card account with its settings, latest statement and latest imported closing. */
export async function loadCards(db: D1Database, userId: number): Promise<CardRow[]> {
  const { results } = await cardsQuery(db, userId).all<CardRow>();
  return results;
}

/** The statement behind loadCards, so the evening job can read many people's cards in one batch. */
export function cardsQuery(db: D1Database, userId: number): D1PreparedStatement {
  return db
    .prepare(
      `SELECT a.id AS account_id, a.name, c.closing_day, c.due_day, c.limit_cents,
         s.id AS st_id, s.closing_date AS st_closing, s.due_date AS st_due, s.min_cents AS st_min, s.full_cents AS st_full,
         (SELECT MAX(i.period_end) FROM imports i WHERE i.user_id = a.user_id AND i.account_id = a.id
            AND i.source IN ('bac_tc', 'agricola_tc') AND i.status = 'done') AS imp_closing
       FROM accounts a
       LEFT JOIN cards c ON c.account_id = a.id AND c.user_id = a.user_id
       LEFT JOIN card_statements s ON s.id = (SELECT id FROM card_statements WHERE user_id = a.user_id AND account_id = a.id
            ORDER BY closing_date DESC LIMIT 1)
       WHERE a.user_id = ? AND a.kind = 'tarjeta' AND a.archived = 0
       ORDER BY a.sort, a.id`,
    )
    .bind(userId);
}

/** The next payment date for a card, from `today` on: a statement's own due date first, else the due day.
 * When the bank moved this cycle's due date a few days before the due day (a weekend or holiday) and it has passed,
 * the due day right after it is the same payment, already made: the next one is a month later. */
export function nextDue(card: CardRow, today: string): string | null {
  if (card.st_due && card.st_due >= today) return card.st_due;
  if (!card.due_day) return null;
  const d = nextDayOfMonth(today, card.due_day);
  if (card.st_due && d > card.st_due && daysBetween(card.st_due, d) < SAME_CYCLE_DAYS) return nextDayOfMonth(shiftDays(d, 1), card.due_day);
  return d;
}

/** Two dates this close belong to one statement cycle (cycles are about a month apart). */
const SAME_CYCLE_DAYS = 10;

/** The next closing date from `today` on. */
export function nextClosing(card: CardRow, today: string): string | null {
  return card.closing_day ? nextDayOfMonth(today, card.closing_day) : null;
}

/** The last closing on or before today. With a closing day: the scheduled one, unless a statement or import we know
 * of closed in that same cycle (a bank closes a day or two off schedule), or later. An older statement never holds the
 * cycle open: Tarjetas would add up purchases already billed. Without a closing day: the latest one we know of. */
export function lastClosing(card: CardRow, today: string): string | null {
  const known = [card.st_closing, card.imp_closing].filter((x): x is string => !!x && x <= today).sort().pop() ?? null;
  if (!card.closing_day) return known;
  let d = nextDayOfMonth(shiftDays(today, -62), card.closing_day);
  for (;;) {
    const n = nextDayOfMonth(shiftDays(d, 1), card.closing_day);
    if (n > today) break;
    d = n;
  }
  return known && known >= shiftDays(d, -SAME_CYCLE_DAYS) ? known : d;
}

/** A card name that is safe on a lock screen: no digits, no symbols, the first word only ("BAC VISA 0000" -> "BAC"). */
export function shortCardName(name: string): string {
  const word = name.normalize("NFC").replace(/[^\p{L}\s]/gu, " ").trim().split(/\s+/)[0] ?? "";
  return word.slice(0, 16);
}

export type StatementFacts = { closing_date: string; due_date?: string | null; min_cents?: number | null; full_cents?: number | null };

/** Record one card statement's dates and payments (one per closing date; a second call updates it).
 * For the Step 3 BAC email script: it reads the statement email and calls this with the card's account id, which
 * must be one of this user's card accounts (checked here). Returns false when it is not.
 * An email or import only fills in what it knows (an empty value keeps the old one). What she types replaces the
 * row: an emptied field is cleared. `replaceId`: the statement she opened, so changing its closing date corrects that
 * row instead of adding a second one behind it. */
export async function recordCardStatement(db: D1Database, userId: number, accountId: number, s: StatementFacts, source: "email" | "import" | "manual", now = Date.now(), replaceId?: number | null): Promise<boolean> {
  const own = await db.prepare("SELECT 1 FROM accounts WHERE id = ? AND user_id = ? AND kind = 'tarjeta'").bind(accountId, userId).first();
  if (!own) return false;
  const keep = (col: string) => (source === "manual" ? `excluded.${col}` : `COALESCE(excluded.${col}, ${col})`);
  const upsert = db
    .prepare(
      `INSERT INTO card_statements (user_id, account_id, closing_date, due_date, min_cents, full_cents, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id, account_id, closing_date) DO UPDATE SET due_date = ${keep("due_date")},
         min_cents = ${keep("min_cents")}, full_cents = ${keep("full_cents")},
         source = excluded.source, updated_at = excluded.updated_at`,
    )
    .bind(userId, accountId, s.closing_date, s.due_date ?? null, s.min_cents ?? null, s.full_cents ?? null, source, now, now);
  if (source === "manual" && replaceId) {
    // the corrected row takes the place of the one she opened (only ever a row of this card)
    await db.batch([
      db.prepare("DELETE FROM card_statements WHERE id = ? AND user_id = ? AND account_id = ? AND closing_date <> ?").bind(replaceId, userId, accountId, s.closing_date),
      upsert,
    ]);
  } else await upsert.run();
  return true;
}

/** Delete this card's saved statements (one by id, or all of them). Movements never change. */
export async function deleteCardStatements(db: D1Database, userId: number, accountId: number, id?: number | null): Promise<number> {
  const r = id
    ? await db.prepare("DELETE FROM card_statements WHERE id = ? AND user_id = ? AND account_id = ?").bind(id, userId, accountId).run()
    : await db.prepare("DELETE FROM card_statements WHERE user_id = ? AND account_id = ?").bind(userId, accountId).run();
  return r.meta.changes ?? 0;
}
