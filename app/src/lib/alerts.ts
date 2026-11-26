// Alertas: what is worth telling her today (card due soon, a limit reached, the weekly summary, the cash reminder),
// shown as banners in the app and sent as at most one evening notification a day (7 pm El Salvador time).
// Lock screens show notifications, so the text names a group or the card's bank at most: no amount, shop, note
// or person, ever.
import { monthBounds, svNow } from "./dates.ts";
import { type CardRow, cardsQuery, daysBetween, nextDue, shortCardName } from "./cards.ts";
import { type FetchLike, sendPush, type VapidKeys, type VapidSigner, vapidSigner } from "./webpush.ts";
import { MAX_SESSION_MS } from "./auth.ts";

export const ALERT_KINDS = ["card", "lim100", "lim80", "week", "cash"] as const; // most urgent first
export type AlertKind = (typeof ALERT_KINDS)[number];
/** Where a tap goes, by kind: fixed screens only, never an address from the message. */
export const ALERT_OPEN: Record<AlertKind, string> = { card: "card", lim100: "limit", lim80: "limit", week: "week", cash: "cash" };

export type Prefs = { lim80: number; lim100: number; card_due: number; weekly: number; cash: number };
export const DEFAULT_PREFS: Prefs = { lim80: 1, lim100: 1, card_due: 1, weekly: 1, cash: 0 };
const PREF_OF: Record<AlertKind, keyof Prefs> = { card: "card_due", lim100: "lim100", lim80: "lim80", week: "weekly", cash: "cash" };

export type AlertItem = { key: string; kind: AlertKind; text: string; days?: number; group_id?: number; account_id?: number };

/** A group name as it may appear on a lock screen: letters and spaces only, short. */
export function safeName(name: string, max = 28): string {
  return name.normalize("NFC").replace(/[^\p{L}\s]/gu, " ").replace(/\s+/g, " ").trim().slice(0, max).trim();
}

const TEXT = {
  es: {
    card: (n: string, d: number) => (n ? `Tu tarjeta ${n} ` : "Tu tarjeta ") + (d === 0 ? "vence hoy" : d === 1 ? "vence mañana" : `vence en ${d} días`),
    lim100: (g: string) => (g ? `${g} llegó al 100% de su límite` : "Un grupo llegó al 100% de su límite"),
    lim80: (g: string) => (g ? `${g} llegó al 80% de su límite` : "Un grupo llegó al 80% de su límite"),
    week: () => "Tu resumen de la semana está listo",
    cash: () => "¿Pagaste algo en efectivo hoy? Anótalo",
    more: (n: number) => `y ${n} más en la app`,
    test: "Las alertas de Finanzas ya funcionan",
  },
  en: {
    card: (n: string, d: number) => (n ? `Your ${n} card ` : "Your card ") + (d === 0 ? "is due today" : d === 1 ? "is due tomorrow" : `is due in ${d} days`),
    lim100: (g: string) => (g ? `${g} reached 100% of its limit` : "A group reached 100% of its limit"),
    lim80: (g: string) => (g ? `${g} reached 80% of its limit` : "A group reached 80% of its limit"),
    week: () => "Your weekly summary is ready",
    cash: () => "Did you pay cash for anything today? Add it",
    more: (n: number) => `and ${n} more in the app`,
    test: "Finanzas alerts are working",
  },
} as const;
export type Lang = keyof typeof TEXT;
export const testText = (lang: Lang) => TEXT[lang].test;

/** Day of the week for an El Salvador date: 0 is Sunday. */
export function weekday(fecha: string): number {
  return new Date(`${fecha}T12:00:00Z`).getUTCDay();
}

export async function loadPrefs(db: D1Database, userId: number): Promise<Prefs> {
  const p = await db.prepare("SELECT lim80, lim100, card_due, weekly, cash FROM alert_prefs WHERE user_id = ?").bind(userId).first<Prefs>();
  return p ?? { ...DEFAULT_PREFS };
}

/** The reads for one person's alert items, as statements: the routes run them as one batch, and the evening job puts
 * every person's into a single batch (a batch is one query against D1's 50 a run on the free plan). */
function itemStatements(db: D1Database, userId: number, today: string, month: string): D1PreparedStatement[] {
  const b = monthBounds(month);
  return [
    db.prepare("SELECT lim80, lim100, card_due, weekly, cash FROM alert_prefs WHERE user_id = ?").bind(userId),
    cardsQuery(db, userId),
    db.prepare(
      `SELECT g.id, g.name, COALESCE(g.limit_cents, (SELECT SUM(limit_cents) FROM categories c WHERE c.group_id = g.id AND c.limit_cents IS NOT NULL)) AS lim
       FROM groups g WHERE g.user_id = ? AND g.archived = 0 ORDER BY g.sort, g.id`,
    ).bind(userId),
    db.prepare(
      `SELECT c.group_id, SUM(CASE m.tipo WHEN 'gasto' THEN m.amount_cents ELSE -m.amount_cents END) AS cents
       FROM movements m JOIN categories c ON c.id = m.category_id
       WHERE m.user_id = ? AND m.fecha BETWEEN ? AND ? AND m.tipo IN ('gasto', 'abono') GROUP BY c.group_id`,
    ).bind(userId, b.start, b.end),
    db.prepare(
      `SELECT EXISTS (SELECT 1 FROM accounts WHERE user_id = ? AND kind = 'efectivo' AND archived = 0) AS has_cash,
         EXISTS (SELECT 1 FROM movements m JOIN accounts a ON a.id = m.account_id
                 WHERE m.user_id = ? AND m.fecha = ? AND a.kind = 'efectivo') AS cash_today,
         (SELECT week_start FROM budget_prefs WHERE user_id = ?) AS week_start`,
    ).bind(userId, userId, today, userId),
    // the marks today's items can have: cards due from today on, this month's limits, today's week and cash
    db.prepare(
      `SELECT key, pushed_day, dismissed_at FROM alert_marks WHERE user_id = ?
         AND ((key LIKE 'card:%' AND substr(key, -10) >= ?) OR key LIKE 'lim%:' || ? OR key IN (?, ?))`,
    ).bind(userId, today, month, `week:${today}`, `cash:${today}`),
  ];
}
const PER_USER = 6;

type Mark = { key: string; pushed_day: string | null; dismissed_at: number | null };

/** Today's items from one person's six results, most urgent first, filtered by her switches, each with whether it
 * already went in a notification and whether its banner was closed. */
function itemsFrom(rs: D1Result[], today: string, hora: string, lang: Lang) {
  const T = TEXT[lang];
  const month = today.slice(0, 7);
  const prefs = (rs[0]!.results[0] as Prefs | undefined) ?? { ...DEFAULT_PREFS };
  const items: AlertItem[] = [];
  if (prefs.card_due) {
    for (const card of rs[1]!.results as CardRow[]) {
      const due = nextDue(card, today);
      if (!due) continue;
      const days = daysBetween(today, due);
      if (days >= 0 && days <= 3) items.push({ key: `card:${card.account_id}:${due}`, kind: "card", text: T.card(shortCardName(card.name), days), days, account_id: card.account_id });
    }
  }
  if (prefs.lim100 || prefs.lim80) {
    const byGroup = new Map((rs[3]!.results as { group_id: number; cents: number }[]).map((r) => [r.group_id, r.cents]));
    for (const g of rs[2]!.results as { id: number; name: string; lim: number | null }[]) {
      if (!g.lim || g.lim <= 0) continue;
      const s = byGroup.get(g.id) ?? 0;
      if (s >= g.lim && prefs.lim100) items.push({ key: `lim100:${g.id}:${month}`, kind: "lim100", text: T.lim100(safeName(g.name)), group_id: g.id });
      else if (s >= g.lim * 0.8 && prefs.lim80) items.push({ key: `lim80:${g.id}:${month}`, kind: "lim80", text: T.lim80(safeName(g.name)), group_id: g.id });
    }
  }
  const cash = rs[4]!.results[0] as { has_cash: number; cash_today: number; week_start: number | null } | undefined;
  // the weekly summary comes on the last day of her week (Ajustes → Tu presupuesto); Monday start = Sunday, as before
  const lastDay = ((cash?.week_start ?? 1) + 6) % 7;
  if (prefs.weekly && weekday(today) === lastDay) items.push({ key: `week:${today}`, kind: "week", text: T.week() });
  if (prefs.cash && hora >= "17:00" && cash?.has_cash && !cash.cash_today) items.push({ key: `cash:${today}`, kind: "cash", text: T.cash() });
  items.sort((x, y) => ALERT_KINDS.indexOf(x.kind) - ALERT_KINDS.indexOf(y.kind));

  const marks = new Map<string, Mark>();
  const rows = rs[5]!.results as Mark[];
  for (const r of rows) marks.set(r.key, r);
  // 100% of a limit already told covers 80% of the same group and month
  for (const r of rows) if (r.key.startsWith("lim100:") && r.pushed_day) marks.set(r.key.replace("lim100", "lim80"), { ...r, key: r.key.replace("lim100", "lim80") });
  return {
    prefs,
    items: items.map((i) => ({ ...i, pushed: !!marks.get(i.key)?.pushed_day, dismissed: !!marks.get(i.key)?.dismissed_at })),
  };
}

/** Everything worth telling her on this El Salvador day (one D1 query). */
export async function alertItems(db: D1Database, userId: number, lang: Lang, nowMs: number) {
  const { fecha: today, hora } = svNow(nowMs);
  const rs = await db.batch(itemStatements(db, userId, today, today.slice(0, 7)));
  return { today, ...itemsFrom(rs, today, hora, lang) };
}

/** The one notification for the day: the most urgent new item as the title, up to two more as short lines. */
export function composeDaily(items: AlertItem[], lang: Lang): { title: string; body: string; open: string } | null {
  if (!items.length) return null;
  const [first, ...rest] = items;
  const lines = rest.slice(0, 2).map((i) => i.text);
  if (rest.length > 2) lines.push(TEXT[lang].more(rest.length - 2));
  return { title: first!.text, body: lines.join("\n"), open: ALERT_OPEN[first!.kind] };
}

export type PushEnv = { DB: D1Database; APP_ORIGIN: string; keys: VapidKeys | null };
type Sub = { id: number; user_id: number; endpoint: string; p256dh: string; auth: string };

/** This user's subscriptions on sessions that still work (an ended session's rows go with it; the 180 days too). */
async function liveSubs(db: D1Database, userId: number, nowMs: number, sessionHash?: string): Promise<Sub[]> {
  const { results } = await db
    .prepare(
      `SELECT p.id, p.user_id, p.endpoint, p.p256dh, p.auth FROM push_subs p JOIN sessions s ON s.token_hash = p.session_hash
       WHERE p.user_id = ? AND s.user_id = p.user_id AND s.expires_at > ? AND s.created_at > ?${sessionHash ? " AND p.session_hash = ?" : ""}`,
    )
    .bind(...[userId, nowMs, nowMs - MAX_SESSION_MS, ...(sessionHash ? [sessionHash] : [])])
    .all<Sub>();
  return results;
}

/** Send to each subscription (one failing never stops the others); returns how many the push services took, and the
 * writes that follow: forget the ones the service says are gone (404, 410), note when the others last worked. */
async function sendAll(env: PushEnv & { keys: VapidKeys }, subs: Sub[], payload: object, fetchFn: FetchLike, nowMs: number, sign: VapidSigner) {
  let ok = 0;
  const after: D1PreparedStatement[] = [];
  for (const s of subs) {
    let status = 0;
    try {
      status = await sendPush(s, payload, env.keys, env.APP_ORIGIN, fetchFn, nowMs, undefined, sign);
    } catch {
      status = 0;
    }
    if (status === 404 || status === 410) after.push(env.DB.prepare("DELETE FROM push_subs WHERE id = ? AND user_id = ?").bind(s.id, s.user_id));
    else if (status >= 200 && status < 300) {
      ok++;
      after.push(env.DB.prepare("UPDATE push_subs SET last_ok_at = ? WHERE id = ? AND user_id = ?").bind(nowMs, s.id, s.user_id));
    }
  }
  return { ok, after };
}

/** Send one message to this user's subscriptions (the test button: this session only). */
export async function deliver(env: PushEnv, userId: number, payload: object, fetchFn: FetchLike, nowMs: number, sessionHash?: string): Promise<number> {
  if (!env.keys) return 0;
  const keyed = { ...env, keys: env.keys };
  const { ok, after } = await sendAll(keyed, await liveSubs(env.DB, userId, nowMs, sessionHash), payload, fetchFn, nowMs, vapidSigner(env.keys, env.APP_ORIGIN, nowMs));
  if (after.length) await env.DB.batch(after);
  return ok;
}

/** Limits for one evening run on the Workers free plan: 50 subrequests (D1 queries and fetches together) and 10 ms of
 * CPU. A run makes 4 D1 queries (who has a phone, everyone's items, the day's claims, the subscription updates) plus
 * one fetch per phone, at most MAX_SENDS. Someone left over this evening (more than about 20 people) is not marked,
 * so her items go the next evening. */
export const RUN_LIMITS = { users: 30, subsPerUser: 3, sends: 40 };

type Status = "sent" | "none" | "capped" | "failed";

/** The evening run for these users: at most one notification per person per El Salvador day (the push_log key is the
 * cap, so a second run that day sends nothing), and each item goes in a notification once. */
async function runUsers(env: PushEnv, users: { id: number; lang: Lang }[], subs: Sub[], fetchFn: FetchLike, nowMs: number): Promise<Map<number, Status>> {
  const out = new Map<number, Status>();
  if (!env.keys || !users.length) return out;
  const keyed = { ...env, keys: env.keys };
  const db = env.DB;
  const { fecha: today, hora } = svNow(nowMs);
  const month = today.slice(0, 7);
  const reads = await db.batch(users.flatMap((u) => itemStatements(db, u.id, today, month)));
  const subsOf = new Map<number, Sub[]>();
  for (const s of subs) subsOf.set(s.user_id, [...(subsOf.get(s.user_id) ?? []), s]);
  let budget = RUN_LIMITS.sends;
  const todo: { id: number; fresh: AlertItem[]; msg: NonNullable<ReturnType<typeof composeDaily>>; subs: Sub[] }[] = [];
  users.forEach((u, i) => {
    out.set(u.id, "none");
    const mine = (subsOf.get(u.id) ?? []).slice(0, RUN_LIMITS.subsPerUser);
    if (!mine.length || mine.length > budget) return; // nothing to reach, or tomorrow: nothing is marked
    try {
      const { items } = itemsFrom(reads.slice(i * PER_USER, (i + 1) * PER_USER), today, hora, u.lang);
      const fresh = items.filter((x) => !x.pushed && !x.dismissed);
      const msg = composeDaily(fresh, u.lang);
      if (!msg) return;
      budget -= mine.length;
      todo.push({ id: u.id, fresh, msg, subs: mine });
    } catch (e) {
      console.error("alerts:", e instanceof Error ? e.message.slice(0, 120) : "unknown");
    }
  });
  if (!todo.length) return out;
  // The day's claims first, in one write: the claim is the lock that keeps a second run that day from sending.
  const claimed = await db.batch(todo.map((t) =>
    db.prepare("INSERT INTO push_log (user_id, day, slot, sent_at, items) VALUES (?, ?, 'daily', ?, ?) ON CONFLICT DO NOTHING RETURNING day")
      .bind(t.id, today, nowMs, t.fresh.length)));
  const sign = vapidSigner(env.keys, env.APP_ORIGIN, nowMs);
  const after: D1PreparedStatement[] = [];
  for (let k = 0; k < todo.length; k++) {
    const t = todo[k]!;
    if (!claimed[k]!.results.length) {
      out.set(t.id, "capped");
      continue;
    }
    const sent = await sendAll(keyed, t.subs, { ...t.msg, tag: "fz-daily" }, fetchFn, nowMs, sign);
    after.push(...sent.after);
    if (sent.ok === 0) {
      // F11: no push service took it: nothing is marked as told, and the claim goes, so a later run can try again
      out.set(t.id, "failed");
      after.push(db.prepare("DELETE FROM push_log WHERE user_id = ? AND day = ? AND slot = 'daily' AND sent_at = ?").bind(t.id, today, nowMs));
      continue;
    }
    out.set(t.id, "sent");
    // F11: the told items are marked only now, after a push service took the message (2xx)
    for (const i of t.fresh.slice(0, 3)) {
      after.push(db.prepare(
        `INSERT INTO alert_marks (user_id, key, pushed_day) VALUES (?, ?, ?)
         ON CONFLICT (user_id, key) DO UPDATE SET pushed_day = COALESCE(pushed_day, excluded.pushed_day)`,
      ).bind(t.id, i.key, today));
    }
  }
  if (after.length) await db.batch(after);
  return out;
}

/** One person's evening run (tests, and the same path the cron takes). */
export async function dailyForUser(env: PushEnv, userId: number, lang: Lang, fetchFn: FetchLike, nowMs: number): Promise<Status> {
  const subs = await liveSubs(env.DB, userId, nowMs);
  return (await runUsers(env, [{ id: userId, lang }], subs, fetchFn, nowMs)).get(userId) ?? "none";
}

/** The daily cron (01:00 UTC = 7 pm in El Salvador): every user with a live subscription who has not had today's
 * notification, inside RUN_LIMITS. */
export async function runDailyAlerts(env: PushEnv, nowMs: number, fetchFn: FetchLike): Promise<number> {
  if (!env.keys) return 0;
  const today = svNow(nowMs).fecha;
  const { results } = await env.DB
    .prepare(
      `SELECT p.id, p.user_id, u.lang, p.endpoint, p.p256dh, p.auth FROM push_subs p JOIN users u ON u.id = p.user_id
       JOIN sessions s ON s.token_hash = p.session_hash AND s.user_id = p.user_id AND s.expires_at > ? AND s.created_at > ?
       WHERE NOT EXISTS (SELECT 1 FROM push_log l WHERE l.user_id = p.user_id AND l.day = ? AND l.slot = 'daily')
       ORDER BY p.user_id, COALESCE(p.last_ok_at, p.created_at) DESC LIMIT ?`,
    )
    .bind(nowMs, nowMs - MAX_SESSION_MS, today, RUN_LIMITS.users * 10)
    .all<Sub & { lang: string }>();
  const users: { id: number; lang: Lang }[] = [];
  for (const r of results) {
    if (users.length >= RUN_LIMITS.users && users[users.length - 1]!.id !== r.user_id) break;
    if (!users.length || users[users.length - 1]!.id !== r.user_id) users.push({ id: r.user_id, lang: r.lang === "en" ? "en" : "es" });
  }
  const ids = new Set(users.map((u) => u.id));
  let sent = 0;
  try {
    for (const s of (await runUsers(env, users, results.filter((r) => ids.has(r.user_id)), fetchFn, nowMs)).values()) if (s === "sent") sent++;
  } catch (e) {
    console.error("alerts:", e instanceof Error ? e.message.slice(0, 120) : "unknown");
  }
  return sent;
}

/** The VAPID keys from config (public) and the Worker secret (private); null when either is missing. */
export function vapidFromEnv(env: unknown): VapidKeys | null {
  const e = env as Record<string, unknown>;
  const pub = typeof e.VAPID_PUBLIC_KEY === "string" ? e.VAPID_PUBLIC_KEY : "";
  const priv = typeof e.VAPID_PRIVATE_KEY === "string" ? e.VAPID_PRIVATE_KEY : "";
  return /^[A-Za-z0-9_-]{87}$/.test(pub) && /^[A-Za-z0-9_-]{43}$/.test(priv) ? { publicKey: pub, privateKey: priv } : null;
}

/** The evening run's schedule: 01:00 UTC is 7 pm in El Salvador (UTC-6 all year, no daylight saving). */
export const DAILY_CRON = "0 1 * * *";

/** Workers' scheduled entry: the daily alerts run, nothing else. */
export async function scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
  if (controller.cron !== DAILY_CRON) return;
  ctx.waitUntil(runDailyAlerts({ DB: env.DB, APP_ORIGIN: env.APP_ORIGIN, keys: vapidFromEnv(env) }, controller.scheduledTime, (u, init) => fetch(u, init)).then(() => undefined));
}
