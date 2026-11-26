// Alertas and Web Push subscriptions, and the extra parts Home shows (fixed payments still to come, card due
// dates, banners). Every route here is behind requireUser and requireUnlocked.
import { Hono } from "hono";
import { z } from "zod";
import { MAX_SESSION_MS } from "../lib/auth.ts";
import { alertItems, ALERT_OPEN, deliver, loadPrefs, testText, vapidFromEnv } from "../lib/alerts.ts";
import { loadCards, nextDue } from "../lib/cards.ts";
import { isValidMonth, shiftDays, svNow } from "../lib/dates.ts";
import { readBody } from "../lib/http.ts";
import { monthPlan } from "../lib/upcoming.ts";
import { loadBudget, weekView } from "../lib/week.ts";
import { isAllowedEndpoint, validKeys } from "../lib/webpush.ts";
import type { AppEnv } from "../types.ts";
import { peopleOn } from "./people.ts";

export const alertRoutes = new Hono<AppEnv>();

const bit = z.boolean().optional();
const PrefsBody = z.object({ lim80: bit, lim100: bit, card_due: bit, weekly: bit, cash: bit });
const KEY_RE = /^(card:\d{1,12}:\d{4}-\d{2}-\d{2}|lim(80|100):\d{1,12}:\d{4}-\d{2}|week:\d{4}-\d{2}-\d{2}|cash:\d{4}-\d{2}-\d{2})$/;
const MAX_SUBS = 10;

alertRoutes.get("/alerts/prefs", async (c) => {
  const user = c.get("user");
  const p = await loadPrefs(c.env.DB, user.id);
  const subscribed = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM push_subs WHERE user_id = ? AND session_hash = ?")
    .bind(user.id, c.get("session").hash).first<{ n: number }>();
  const keys = vapidFromEnv(c.env);
  return c.json({
    prefs: Object.fromEntries(Object.entries(p).map(([k, v]) => [k, v === 1])),
    public_key: keys?.publicKey ?? null,
    subscribed: (subscribed?.n ?? 0) > 0,
  });
});

alertRoutes.put("/alerts/prefs", async (c) => {
  const user = c.get("user");
  const b = await readBody(c, PrefsBody);
  // F46: only the switches sent change (two quick taps on different switches never undo each other). A new row
  // starts from the defaults (loadPrefs) with the sent ones applied.
  const p = { ...(await loadPrefs(c.env.DB, user.id)) };
  const v = (k: "lim80" | "lim100" | "card_due" | "weekly" | "cash") => (b[k] === undefined ? null : b[k] ? 1 : 0);
  for (const k of ["lim80", "lim100", "card_due", "weekly", "cash"] as const) if (b[k] !== undefined) p[k] = b[k] ? 1 : 0;
  await c.env.DB
    .prepare(
      `INSERT INTO alert_prefs (user_id, lim80, lim100, card_due, weekly, cash, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET lim80 = COALESCE(?, lim80), lim100 = COALESCE(?, lim100), card_due = COALESCE(?, card_due),
         weekly = COALESCE(?, weekly), cash = COALESCE(?, cash), updated_at = excluded.updated_at`,
    )
    .bind(user.id, p.lim80, p.lim100, p.card_due, p.weekly, p.cash, Date.now(), v("lim80"), v("lim100"), v("card_due"), v("weekly"), v("cash"))
    .run();
  return c.json({ ok: true });
});

/** The banners for today: every current item whose banner she has not closed. */
alertRoutes.get("/alerts", async (c) => {
  const user = c.get("user");
  const { items } = await alertItems(c.env.DB, user.id, user.lang, Date.now());
  return c.json({ items: items.filter((i) => !i.dismissed).map((i) => ({ key: i.key, kind: i.kind, text: i.text, open: ALERT_OPEN[i.kind] })) });
});

alertRoutes.post("/alerts/dismiss", async (c) => {
  const user = c.get("user");
  const b = await readBody(c, z.object({ key: z.string().regex(KEY_RE) }));
  await c.env.DB
    .prepare(
      `INSERT INTO alert_marks (user_id, key, dismissed_at) VALUES (?, ?, ?)
       ON CONFLICT (user_id, key) DO UPDATE SET dismissed_at = excluded.dismissed_at`,
    )
    .bind(user.id, b.key, Date.now())
    .run();
  return c.json({ ok: true });
});

const SubBody = z.object({
  endpoint: z.string().max(1024),
  keys: z.object({ p256dh: z.string().max(100), auth: z.string().max(32) }),
});

/** Save this phone's push subscription, tied to this session (it goes when the session ends). Only https addresses
 * on the real push services are accepted. */
alertRoutes.post("/push/subscription", async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const b = await readBody(c, SubBody);
  if (!isAllowedEndpoint(b.endpoint)) return c.json({ error: "invalid:endpoint" }, 400);
  if (!validKeys(b.keys.p256dh, b.keys.auth)) return c.json({ error: "invalid:keys" }, 400);
  const n = await db.prepare("SELECT COUNT(*) AS n FROM push_subs WHERE user_id = ? AND endpoint <> ?").bind(user.id, b.endpoint).first<{ n: number }>();
  if ((n?.n ?? 0) >= MAX_SUBS) return c.json({ error: "too_many" }, 409);
  // The address belongs to one browser, and a browser has one session. Another person's row for it is taken over
  // only when her session no longer works (she signed out there and it expired); otherwise it is refused.
  const now = Date.now();
  const other = await db
    .prepare(
      `SELECT 1 FROM push_subs p JOIN sessions s ON s.token_hash = p.session_hash
       WHERE p.endpoint = ? AND p.user_id <> ? AND s.expires_at > ? AND s.created_at > ?`,
    )
    .bind(b.endpoint, user.id, now, now - MAX_SESSION_MS)
    .first();
  if (other) return c.json({ error: "taken" }, 409);
  await db.batch([
    db.prepare("DELETE FROM push_subs WHERE endpoint = ?").bind(b.endpoint),
    db.prepare("INSERT INTO push_subs (user_id, session_hash, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(user.id, c.get("session").hash, b.endpoint, b.keys.p256dh, b.keys.auth, now),
  ]);
  return c.json({ ok: true }, 201);
});

alertRoutes.delete("/push/subscription", async (c) => {
  const user = c.get("user");
  await c.env.DB.prepare("DELETE FROM push_subs WHERE user_id = ? AND session_hash = ?").bind(user.id, c.get("session").hash).run();
  return c.json({ ok: true });
});

/** "Probar": one fixed message to this phone only, at most 3 a day. */
alertRoutes.post("/push/test", async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const keys = vapidFromEnv(c.env);
  if (!keys) return c.json({ error: "not_configured" }, 409);
  const now = Date.now();
  const today = svNow(now).fecha;
  // The claim is the write itself (the first free slot of three, RETURNING): tests sent at the same moment cannot all
  // take the same free slot and pass the cap.
  const claim = await db
    .prepare(
      `INSERT INTO push_log (user_id, day, slot, sent_at)
       SELECT ?, ?, s.slot, ? FROM (SELECT 'test1' AS slot UNION ALL SELECT 'test2' UNION ALL SELECT 'test3') s
       WHERE NOT EXISTS (SELECT 1 FROM push_log l WHERE l.user_id = ? AND l.day = ? AND l.slot = s.slot)
       ORDER BY s.slot LIMIT 1
       ON CONFLICT DO NOTHING RETURNING slot`,
    )
    .bind(user.id, today, now, user.id, today)
    .first<{ slot: string }>();
  if (!claim) return c.json({ error: "slow_down" }, 429);
  const sent = await deliver({ DB: db, APP_ORIGIN: c.env.APP_ORIGIN, keys }, user.id, { title: testText(user.lang), body: "", open: "home", tag: "fz-test" },
    fetch, now, c.get("session").hash);
  return c.json({ ok: sent > 0, sent });
});

/** Home's extra part: what is still to come (fixed payments and card due dates, 14 days), the money the month's
 * unpaid fixed payments will take, and today's banners. Only the current month has anything to come. */
alertRoutes.get("/home/extras", async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const now = Date.now();
  const today = svNow(now).fecha;
  const q = c.req.query("month") ?? "";
  const month = isValidMonth(q) ? q : today.slice(0, 7);
  const current = month === today.slice(0, 7);
  const plan = await monthPlan(db, user.id, today, month);
  const names = new Map<number, string>();
  if (plan.upcoming.length) {
    const { results } = await db.prepare("SELECT id, name FROM recurring WHERE user_id = ?").bind(user.id).all<{ id: number; name: string }>();
    for (const r of results) names.set(r.id, r.name);
  }
  const upcoming: { kind: "recurring" | "card"; id: number; name: string; fecha: string; amount_cents: number | null }[] = current
    ? plan.upcoming.map((o) => ({ kind: "recurring" as const, id: o.recurring_id, name: names.get(o.recurring_id) ?? "", fecha: o.fecha, amount_cents: o.amount_cents }))
    : [];
  if (current) {
    for (const k of await loadCards(db, user.id)) {
      const due = nextDue(k, today);
      if (due && due <= shiftDays(today, 14)) upcoming.push({ kind: "card", id: k.account_id, name: k.name, fecha: due, amount_cents: k.st_due === due ? k.st_full : null });
    }
  }
  upcoming.sort((a, b) => (a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : 0));
  const banners = current
    ? (await alertItems(db, user.id, user.lang, now)).items.filter((i) => !i.dismissed).map((i) => ({ key: i.key, kind: i.kind, text: i.text, open: ALERT_OPEN[i.kind] }))
    : [];
  return c.json({
    month, today,
    committed_cents: plan.committed_cents,
    committed_limited_cents: plan.committed_limited_cents,
    upcoming: upcoming.slice(0, 8),
    banners,
    people_on: await peopleOn(db, user.id),
    // weekly "Te quedan" (Feature 3): only this month, only for someone who counts per week
    ...(current ? await weekPart(db, user.id, today) : {}),
  });
});

async function weekPart(db: D1Database, userId: number, today: string) {
  const prefs = await loadBudget(db, userId);
  return prefs.period === "week" ? { week: await weekView(db, userId, today, prefs) } : {};
}
