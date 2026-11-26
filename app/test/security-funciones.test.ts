// Seguridad's review of the Funciones branch (Nov 25 2026): one test per fix. The evening job inside the free plan's
// 50 subrequests a run, the test button's cap under parallel taps, Importar's kept answers in one query, the import
// undo after a merge bringing the Personas line back to the typed purchase, a merge whose rate would not fit, and
// the Worker's entry carrying both fetch and the cron.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import * as entry from "../src/index.ts";
import app from "../src/index.ts";
import { RUN_LIMITS, runDailyAlerts, scheduled, type PushEnv } from "../src/lib/alerts.ts";
import { mergedRate } from "../src/lib/merge.ts";
import { b64u, type VapidKeys } from "../src/lib/webpush.ts";
import { BASE, call, json, makeUser, type TestUser } from "./helpers.ts";

const db = () => env.DB;
const ORIGIN = "https://finanzas.test";
/** SV Sunday Dec 6 2026, 7 pm = Monday Dec 7, 01:00 UTC (the cron's time). */
const SUN = Date.UTC(2026, 11, 7, 1, 0);

/** D1 with a counter: every first/all/run/raw is one query, a whole batch is one (as D1 counts them). */
function counting(real: D1Database) {
  const n = { queries: 0 };
  const realOf = new WeakMap<object, D1PreparedStatement>();
  const wrap = (s: D1PreparedStatement): D1PreparedStatement => {
    const p = new Proxy(s, {
      get(t, k) {
        if (k === "bind") return (...a: unknown[]) => wrap(t.bind(...a));
        if (k === "first" || k === "all" || k === "run" || k === "raw") {
          return (...a: unknown[]) => {
            n.queries++;
            return (t as unknown as Record<string, (...x: unknown[]) => unknown>)[k as string]!.apply(t, a);
          };
        }
        const v = (t as unknown as Record<string | symbol, unknown>)[k];
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    realOf.set(p, s);
    return p;
  };
  const proxied = new Proxy(real, {
    get(t, k) {
      if (k === "prepare") return (q: string) => wrap(t.prepare(q));
      if (k === "batch") {
        return (ss: D1PreparedStatement[]) => {
          n.queries++;
          return t.batch(ss.map((s) => realOf.get(s) ?? s));
        };
      }
      const v = (t as unknown as Record<string | symbol, unknown>)[k];
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
  return { db: proxied, n };
}

async function vapidKeys(): Promise<VapidKeys> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  return { publicKey: b64u((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer), privateKey: ((await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey).d! };
}

let ep = 0;
async function subscribe(u: TestUser) {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const p256dh = b64u((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  const auth = b64u(crypto.getRandomValues(new Uint8Array(16)));
  const endpoint = `https://web.push.apple.com/QF-sec-${++ep}-${Math.random().toString(36).slice(2)}`;
  expect((await call("POST", "/api/push/subscription", { endpoint, keys: { p256dh, auth } }, u.cookie)).status).toBe(201);
  return endpoint;
}

describe("the evening job stays inside the free plan's limits", () => {
  it("20 people with 2 phones each on a Sunday: every phone gets one, in at most 50 subrequests and 4 signatures", async () => {
    const users: TestUser[] = [];
    for (let i = 0; i < 20; i++) users.push(await makeUser("cr"));
    await db().prepare(`DELETE FROM push_subs WHERE user_id NOT IN (${users.map((u) => u.id).join(",")})`).run();
    const eps: string[] = [];
    for (const u of users) eps.push(await subscribe(u), await subscribe(u));
    const keys = await vapidKeys();
    const { db: cdb, n } = counting(db());
    const calls: { url: string; auth: string }[] = [];
    const fetchFn = async (url: string, init: RequestInit) => {
      calls.push({ url, auth: (init.headers as Record<string, string>).Authorization! });
      if (url === eps[3]) throw new Error("network down"); // one failing phone stops nobody else
      return new Response(null, { status: 201 });
    };
    const penv: PushEnv = { DB: cdb, APP_ORIGIN: ORIGIN, keys };
    expect(await runDailyAlerts(penv, SUN, fetchFn)).toBe(20);
    expect(calls.length).toBe(40);
    expect(new Set(calls.map((c) => c.url))).toEqual(new Set(eps));
    expect(n.queries).toBeLessThanOrEqual(4);
    expect(n.queries + calls.length).toBeLessThanOrEqual(50);
    expect(new Set(calls.map((c) => c.auth)).size).toBe(1); // one VAPID claim for Apple's service, signed once
    // the failed phone keeps its subscription; the others are marked as working
    const ok = await db().prepare(`SELECT COUNT(*) AS n FROM push_subs WHERE last_ok_at = ?`).bind(SUN).first<{ n: number }>();
    expect(ok!.n).toBe(39);
    // a second run the same evening sends nothing and reads almost nothing
    n.queries = 0;
    calls.length = 0;
    expect(await runDailyAlerts(penv, SUN + 60_000, fetchFn)).toBe(0);
    expect(calls.length).toBe(0);
    expect(n.queries).toBe(1);
  });

  it("more phones than one run may reach: the rest are left unmarked for the next evening, never over 50", async () => {
    const users: TestUser[] = [];
    for (let i = 0; i < 25; i++) users.push(await makeUser("cx"));
    await db().prepare(`DELETE FROM push_subs WHERE user_id NOT IN (${users.map((u) => u.id).join(",")})`).run();
    for (const u of users) await subscribe(u), await subscribe(u);
    const keys = await vapidKeys();
    const { db: cdb, n } = counting(db());
    let fetches = 0;
    const fetchFn = async () => (fetches++, new Response(null, { status: 201 }));
    const sent = await runDailyAlerts({ DB: cdb, APP_ORIGIN: ORIGIN, keys }, SUN + 86_400_000 * 7, fetchFn);
    expect(fetches).toBe(RUN_LIMITS.sends);
    expect(sent).toBe(RUN_LIMITS.sends / 2);
    expect(n.queries + fetches).toBeLessThanOrEqual(50);
    const ids = users.map((u) => u.id).join(",");
    const logged = await db().prepare(`SELECT COUNT(*) AS n FROM push_log WHERE slot = 'daily' AND user_id IN (${ids})`).first<{ n: number }>();
    const marked = await db().prepare(`SELECT COUNT(DISTINCT user_id) AS n FROM alert_marks WHERE pushed_day IS NOT NULL AND user_id IN (${ids})`).first<{ n: number }>();
    expect(logged!.n).toBe(sent);
    expect(marked!.n).toBe(sent);
  });
});

describe("the test button", () => {
  it("6 taps at the same moment send at most 3 tests a day", async () => {
    const u = await makeUser("tb");
    const keys = await vapidKeys();
    const withKeys = { ...env, VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: keys.privateKey };
    const tap = () => app.request(`${BASE}/api/push/test`, { method: "POST", headers: { cookie: u.cookie, "content-type": "application/json" } }, withKeys);
    const res = await Promise.all(Array.from({ length: 6 }, tap));
    expect(res.map((r) => r.status).sort()).toEqual([200, 200, 200, 429, 429, 429]);
    const rows = await db().prepare("SELECT slot FROM push_log WHERE user_id = ? ORDER BY slot").bind(u.id).all<{ slot: string }>();
    expect(rows.results.map((r) => r.slot)).toEqual(["test1", "test2", "test3"]);
  });
});

describe("Recurrentes: Importar's kept answers", () => {
  it("55 kept answers become Recurrentes in one request, far below D1's 50 queries", async () => {
    const u = await makeUser("rk");
    const stmts: D1PreparedStatement[] = [];
    for (let i = 0; i < 55; i++) {
      const key = `servicio ${String(i).padStart(2, "0")}`;
      stmts.push(db().prepare("INSERT INTO recurring_choices (user_id, merchant_key, keep, amount_cents, every_days, updated_at) VALUES (?, ?, 1, 1500, 30, ?)").bind(u.id, key, i));
      stmts.push(db().prepare(`INSERT INTO movements (user_id, fecha, amount_cents, tipo, comercio, merchant_key, account_id, origen, dedupe_key, created_at, updated_at)
        VALUES (?, '2026-11-02', 1500, 'gasto', ?, ?, ?, 'manual', ?, 1, 1)`).bind(u.id, key.toUpperCase(), key, u.accountId, `rk:${u.id}:${i}`));
    }
    await db().batch(stmts);
    const { db: cdb, n } = counting(db());
    const res = await app.request(`${BASE}/api/recurring`, { headers: { cookie: u.cookie } }, { ...env, DB: cdb });
    expect(res.status).toBe(200);
    expect((await res.json<{ items: unknown[] }>()).items).toHaveLength(55);
    expect(n.queries).toBeLessThan(15);
  });
});

describe("import undo after a merge", () => {
  it("brings the Personas line back to the typed purchase, with the same balance", async () => {
    const u = await makeUser("iu");
    const ana = (await json(call("POST", "/api/people", { name: "Ana" }, u.cookie))).id as number;
    const typed = (await json(call("POST", "/api/movements", {
      client_id: `iu-${u.id}-typed-1`, amount_cents: 4000, fecha: "2026-10-15", comercio: "Super Uno", account_id: u.accountId, category_id: u.cats.Supermercado,
    }, u.cookie))).movement;
    expect((await call("POST", `/api/people/${ana}/share`, { movement_id: typed.id, kind: "shared", cents: 2000 }, u.cookie)).status).toBe(201);
    const s = await call("POST", "/api/imports", { account_id: u.accountId, source: "bac_tc", balanced: true, period_start: "2026-10-01", period_end: "2026-10-31" }, u.cookie);
    const imp = (await json(s)).id as number;
    expect((await call("POST", `/api/imports/${imp}/rows`, { part: 0, rows: [{ fecha: "2026-10-15", comercio: "SUPER UNO", cents: 4000, dir: "out" }] }, u.cookie)).status).toBe(200);
    expect((await json(call("POST", `/api/imports/${imp}/finish`, {}, u.cookie))).totals.merged).toBe(1);
    const line = () => db().prepare("SELECT movement_id FROM person_entries WHERE user_id = ? AND person_id = ?").bind(u.id, ana).first<{ movement_id: number | null }>();
    const onBank = (await line())!.movement_id;
    expect(onBank).not.toBeNull();
    expect(onBank).not.toBe(typed.id);
    expect((await call("POST", `/api/imports/${imp}/undo`, {}, u.cookie)).status).toBe(200);
    const back = await db().prepare("SELECT id FROM movements WHERE user_id = ? AND dedupe_key = ?").bind(u.id, `manual:iu-${u.id}-typed-1`).first<{ id: number }>();
    expect(back).not.toBeNull();
    expect((await line())!.movement_id).toBe(back!.id);
    expect((await json(call("GET", `/api/people/${ana}`, undefined, u.cookie))).person.balance_cents).toBe(2000);
    expect(await db().prepare("SELECT 1 FROM movements WHERE id = ?").bind(onBank).first()).toBeNull();
  });
});

describe("Moneda: a merge's rate", () => {
  it("a rate that would not fit the column is left out instead of failing the merge", async () => {
    expect(mergedRate({ orig_cents: 100_000_000_000_000, fx_micros: 1, fee_cents: null, amount_cents: 1 }, 2)).toBeNull();
    expect(mergedRate({ orig_cents: 4_000_000, fx_micros: 3_999_000_000, fee_cents: null, amount_cents: 1000 }, 1000)).toBe(3_999_000_000);
    expect(mergedRate({ orig_cents: 4_000_000, fx_micros: 3_999_000_000, fee_cents: null, amount_cents: 1000 }, 1001)).toBe(3_996_003_996);
    const u = await makeUser("mf");
    const typed = (await json(call("POST", "/api/movements", {
      client_id: `mf-${u.id}-rate-check`, amount_cents: 1, comercio: "Kiosco", account_id: u.accountId,
      fx: { currency: "COP", cents: 100_000_000_000_000, micros: 1 },
    }, u.cookie))).movement;
    const bank = await db().prepare(`INSERT INTO movements (user_id, fecha, amount_cents, tipo, comercio, merchant_key, account_id, origen, dedupe_key, created_at, updated_at)
      VALUES (?, ?, 2, 'gasto', 'KIOSCO', 'kiosco', ?, 'correo BAC', ?, 1, 1) RETURNING id`).bind(u.id, typed.fecha, u.accountId, `bac:mf-${u.id}`).first<{ id: number }>();
    const r = await call("POST", `/api/movements/${typed.id}/merge`, { bank_id: bank!.id }, u.cookie);
    expect(r.status).toBe(200);
    expect((await json(r)).movement.fx).toEqual({ currency: "COP", cents: 100_000_000_000_000, micros: null, fee_cents: null });
  });
});

describe("worker entry", () => {
  it("one default export carrying the app's fetch and the alerts cron, and no named export", () => {
    expect(Object.keys(entry)).toEqual(["default"]);
    const w = entry.default as unknown as { fetch: unknown; scheduled: unknown; request: unknown };
    expect(typeof w.fetch).toBe("function");
    expect(w.scheduled).toBe(scheduled);
    expect(typeof w.request).toBe("function");
  });
});
