// UI audit (Nov 25 2026): alerts repros. Synthetic users only, isolated D1. Prints FACT lines for the findings file.
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { alertItems, dailyForUser, type PushEnv } from "../src/lib/alerts.ts";
import { b64u, type VapidKeys } from "../src/lib/webpush.ts";
import { call, json, makeUser, type TestUser } from "./helpers.ts";

const db = () => env.DB;
const ORIGIN = "https://finanzas.test";
const DAY = 86_400_000;
/** 7 pm in El Salvador on SV date y-m-d is 01:00 UTC the next day (the cron's time). */
const sv7pm = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d + 1, 1, 0);

async function vapidKeys(): Promise<VapidKeys> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  return { publicKey: b64u((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer), privateKey: ((await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey).d! };
}
async function subscribe(u: TestUser) {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const p256dh = b64u((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  const auth = b64u(crypto.getRandomValues(new Uint8Array(16)));
  const endpoint = `https://web.push.apple.com/QA-UI-${Math.random().toString(36).slice(2)}`;
  const res = await call("POST", "/api/push/subscription", { endpoint, keys: { p256dh, auth } }, u.cookie);
  expect(res.status).toBe(201);
}
function stub(status = 201) {
  const sent: string[] = [];
  return { sent, fetchFn: async (url: string) => (sent.push(url), new Response(null, { status })) };
}

it("F12 (fixed) card alert: a statement due one day before the due day gives one push, not a late 'vence hoy'", async () => {
  const u = await makeUser("qaui-card");
  await subscribe(u);
  const penv: PushEnv = { DB: db(), APP_ORIGIN: ORIGIN, keys: await vapidKeys() };
  // Card A: due day 18 in its settings; the November statement says the payment is due Tuesday Nov 17.
  await call("PUT", `/api/cards/${u.accountId}`, { closing_day: 20, due_day: 18 }, u.cookie);
  const st = await call("POST", `/api/cards/${u.accountId}/statement`, { closing_date: "2026-10-20", due_date: "2026-11-17" }, u.cookie);
  expect(st.status).toBeLessThan(300);
  await db().prepare("INSERT INTO alert_prefs (user_id, lim80, lim100, card_due, weekly, cash, updated_at) VALUES (?, 0, 0, 1, 0, 0, 1)").bind(u.id).run();
  const runs: { day: string; status: string; sent: number; items: string[] }[] = [];
  for (let d = 13; d <= 19; d++) {
    const now = sv7pm(2026, 11, d);
    const items = (await alertItems(db(), u.id, "es", now)).items.map((i) => `${i.key.replace(/^card:\d+:/, "card:")} ${i.text}`);
    const s = stub();
    const status = await dailyForUser(penv, u.id, "es", s.fetchFn, now);
    runs.push({ day: `2026-11-${d}`, status, sent: s.sent.length, items });
  }
  console.log("FACT card_twice", JSON.stringify(runs));
  // Expected: one push (Nov 14, "vence en 3 días") and nothing after the real due date of Nov 17.
  const pushes = runs.filter((r) => r.status === "sent").map((r) => r.day);
  expect(pushes).toEqual(["2026-11-14"]);
});

it("F46 (fixed) alert switches: two quick toggles of different switches both stick", async () => {
  const u = await makeUser("qaui-prefs");
  const [a, b] = await Promise.all([
    call("PUT", "/api/alerts/prefs", { lim80: false }, u.cookie),
    call("PUT", "/api/alerts/prefs", { weekly: false }, u.cookie),
  ]);
  expect(a.status).toBe(200);
  expect(b.status).toBe(200);
  const p = (await json(call("GET", "/api/alerts/prefs", undefined, u.cookie))).prefs;
  console.log("FACT prefs_race", JSON.stringify(p));
  expect(p.lim80).toBe(false);
  expect(p.weekly).toBe(false);
  expect(p.lim100).toBe(true); // the others keep their defaults
});

it("F11 (fixed): a push the provider refused (503) is reported failed, marks nothing, and goes on the next run", async () => {
  const u = await makeUser("qaui-f08");
  await subscribe(u);
  const penv: PushEnv = { DB: db(), APP_ORIGIN: ORIGIN, keys: await vapidKeys() };
  await db().prepare("INSERT INTO cards (account_id, user_id, due_day, updated_at) VALUES (?, ?, 1, 1)").bind(u.accountId, u.id).run();
  await db().prepare("INSERT INTO alert_prefs (user_id, lim80, lim100, card_due, weekly, cash, updated_at) VALUES (?, 0, 0, 1, 0, 0, 1)").bind(u.id).run();
  const down = stub(503);
  const first = await dailyForUser(penv, u.id, "es", down.fetchFn, sv7pm(2026, 11, 28));
  const up = stub(201);
  const sameNight = await dailyForUser(penv, u.id, "es", up.fetchFn, sv7pm(2026, 11, 28) + 60_000);
  const nextNight = stub(201);
  const next = await dailyForUser(penv, u.id, "es", nextNight.fetchFn, sv7pm(2026, 11, 28) + DAY);
  const log = await db().prepare("SELECT day, slot FROM push_log WHERE user_id = ?").bind(u.id).all();
  const marks = await db().prepare("SELECT key, pushed_day FROM alert_marks WHERE user_id = ?").bind(u.id).all<{ key: string; pushed_day: string }>();
  const r = { first, providerStatus: 503, sameNight, sameNightAttempts: up.sent.length, nextNight: next, nextNightAttempts: nextNight.sent.length,
    push_log: log.results, marks: marks.results.map((m) => ({ key: m.key.replace(/^card:\d+:/, "card:"), pushed_day: m.pushed_day })) };
  console.log("FACT f08", JSON.stringify(r));
  expect(first).toBe("failed");
  expect(sameNight).toBe("sent"); // the claim went with the failure, so a later run that night tries again
  expect(up.sent.length).toBe(1);
  expect(r.marks.map((m) => m.pushed_day)).toEqual(["2026-11-28"]); // marked only by the run that got through
  expect(next).toBe("none"); // told once: nothing new the next night
  expect(nextNight.sent.length).toBe(0);
});
