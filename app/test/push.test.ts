// Funciones (Wave 2): Web Push and the evening alerts. RFC 8291 test vector, the push-service allowlist, the
// VAPID claim, one notification per person per El Salvador day in priority order, limit levels once a month,
// El Salvador time for "today" and "Sunday", and no amount, shop or card number in what a lock screen shows.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { alertItems, composeDaily, dailyForUser, DAILY_CRON, runDailyAlerts, scheduled, weekday, type PushEnv } from "../src/lib/alerts.ts";
import { b64u, encryptPush, isAllowedEndpoint, unb64u, type VapidKeys } from "../src/lib/webpush.ts";
import { call, json, makeUser, type TestUser } from "./helpers.ts";

const db = () => env.DB;
const enc = new TextEncoder();
const ORIGIN = "https://finanzas.test";
/** SV Sunday Nov 29 2026, 7 pm = Monday Nov 30, 01:00 UTC (the cron's time). */
const SUN_7PM = Date.UTC(2026, 10, 30, 1, 0);
const DAY = 86_400_000;

async function vapidKeys(): Promise<VapidKeys> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  return { publicKey: b64u((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer), privateKey: (await crypto.subtle.exportKey("jwk", pair.privateKey) as JsonWebKey).d! };
}

/** A phone's subscription keys, with the private half kept so the test can read what was sent. */
async function phone() {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const pub = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return { p256dh: b64u(pub), auth: b64u(auth), priv: pair.privateKey, pub, authBytes: auth };
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, n: number) {
  const k = await crypto.subtle.importKey("raw", new Uint8Array(ikm), "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(salt), info: new Uint8Array(info) }, k, n * 8));
}

/** The phone's side of RFC 8291: read one aes128gcm message. */
async function decrypt(body: Uint8Array, p: Awaited<ReturnType<typeof phone>>): Promise<string> {
  const salt = body.slice(0, 16);
  const idlen = body[20]!;
  const asPub = body.slice(21, 21 + idlen);
  const asKey = await crypto.subtle.importKey("raw", asPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: asKey } as unknown as SubtleCryptoDeriveKeyAlgorithm, p.priv, 256));
  const info = new Uint8Array([...enc.encode("WebPush: info\0"), ...p.pub, ...asPub]);
  const ikm = await hkdf(p.authBytes, ecdh, info, 32);
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, body.slice(21 + idlen)));
  expect(plain[plain.length - 1]).toBe(2); // the last-record padding delimiter
  return new TextDecoder().decode(plain.slice(0, -1));
}

type Sent = { url: string; headers: Record<string, string>; body: Uint8Array };
/** A stand-in push service: records each request and answers with `status`. Nothing leaves the test. */
function stub(status = 201) {
  const sent: Sent[] = [];
  const fetchFn = async (url: string, init: RequestInit) => {
    sent.push({ url, headers: Object.fromEntries(Object.entries(init.headers as Record<string, string>)), body: new Uint8Array(init.body as Uint8Array) });
    return new Response(null, { status });
  };
  return { sent, fetchFn };
}

let ep = 0;
/** A subscription on Apple's real push host (the stub answers for it), saved through the API for this session. */
async function subscribe(u: TestUser) {
  const p = await phone();
  const endpoint = `https://web.push.apple.com/QF-test-${++ep}-${Math.random().toString(36).slice(2)}`;
  const res = await call("POST", "/api/push/subscription", { endpoint, keys: { p256dh: p.p256dh, auth: p.auth } }, u.cookie);
  expect(res.status).toBe(201);
  return { ...p, endpoint };
}

async function spend(u: TestUser, fecha: string, cents: number, comercio = "Tienda Secreta", cat = u.cats.Supermercado) {
  await db().prepare(`INSERT INTO movements (user_id, fecha, amount_cents, tipo, comercio, merchant_key, account_id, category_id, origen, dedupe_key, created_at, updated_at)
    VALUES (?, ?, ?, 'gasto', ?, '', ?, ?, 'manual', ?, 1, 1)`).bind(u.id, fecha, cents, comercio, u.accountId, cat, `t:${Math.random()}`).run();
}

describe("Web Push encryption (RFC 8291) and the VAPID claim (RFC 8292)", () => {
  it("matches RFC 8291 Appendix A byte for byte", async () => {
    const out = await encryptPush(unb64u("V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24"),
      "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4", "BTBZMqHH6r4Tts7J_aSIgg", {
        fixed: {
          asPrivate: unb64u("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw"),
          asPublic: unb64u("BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8"),
          salt: unb64u("DGv6ra1nlYgDCS1FRnbzlw"),
        },
      });
    expect(b64u(out)).toBe("DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN");
  });

  it("sends an encrypted body the phone can read, a short TTL and a VAPID claim whose sub is the app's https origin", async () => {
    const u = await makeUser("pv");
    const p = await subscribe(u);
    const keys = await vapidKeys();
    await spend(u, "2026-11-10", 50000);
    const { sent, fetchFn } = stub();
    expect(await dailyForUser({ DB: db(), APP_ORIGIN: ORIGIN, keys }, u.id, "es", fetchFn, SUN_7PM)).toBe("sent");
    expect(sent).toHaveLength(1);
    const r = sent[0]!;
    expect(r.url).toBe(p.endpoint);
    expect(r.headers["Content-Encoding"]).toBe("aes128gcm");
    expect(Number(r.headers.TTL)).toBeGreaterThan(0);
    expect(Number(r.headers.TTL)).toBeLessThanOrEqual(24 * 3600);
    const m = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(r.headers.Authorization!);
    expect(m).not.toBeNull();
    expect(m![4]).toBe(keys.publicKey);
    const claims = JSON.parse(new TextDecoder().decode(unb64u(m![2]!)));
    expect(claims.aud).toBe("https://web.push.apple.com");
    expect(claims.sub).toBe(ORIGIN);
    expect(claims.sub).not.toMatch(/@|mailto/);
    expect(claims.exp * 1000 - SUN_7PM).toBeLessThanOrEqual(24 * 3600 * 1000);
    const verifyKey = await crypto.subtle.importKey("raw", unb64u(keys.publicKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, verifyKey, unb64u(m![3]!), enc.encode(`${m![1]}.${m![2]}`))).toBe(true);
    const payload = JSON.parse(await decrypt(r.body, p));
    expect(payload.title).toBe("Comida llegó al 100% de su límite");
    expect(payload.open).toBe("limit");
  });
});

describe("push services allowlist", () => {
  it("allows only https on Apple, Google, Mozilla and Microsoft push hosts", () => {
    for (const ok of ["https://web.push.apple.com/abc", "https://fcm.googleapis.com/fcm/send/x", "https://updates.push.services.mozilla.com/wpush/v2/x",
      "https://wns2-by3p.notify.windows.com/w/?token=x"])
      expect(isAllowedEndpoint(ok), ok).toBe(true);
    for (const bad of ["http://fcm.googleapis.com/fcm/send/x", "https://evil.example/x", "https://fcm.googleapis.com.evil.example/x",
      "https://push.apple.com/x", "https://evilpush.apple.com.example/x", ["https://user:pw", "fcm.googleapis.com/x"].join("@"), "https://fcm.googleapis.com:8443/x", "https://web.push.apple.com:443/abc",
      "https://127.0.0.1/x", "https://localhost/x", "https://[::1]/x", "javascript:alert(1)", "https://xn--fcm-googleapis.com/x",
      "https:fcm.googleapis.com/x", "https://FCM.googleapis.com/x", "https://fcm.googleapis.com", `https://web.push.apple.com/${"a".repeat(1100)}`]) {
      expect(isAllowedEndpoint(bad), bad).toBe(false);
    }
  });

  it("the API refuses any other address and bad keys, and saves nothing", async () => {
    const u = await makeUser("pa");
    const p = await phone();
    for (const endpoint of ["https://evil.example/x", "http://fcm.googleapis.com/fcm/send/x", "https://169.254.169.254/latest"]) {
      const r = await call("POST", "/api/push/subscription", { endpoint, keys: { p256dh: p.p256dh, auth: p.auth } }, u.cookie);
      expect(r.status).toBe(400);
    }
    const r = await call("POST", "/api/push/subscription", { endpoint: "https://fcm.googleapis.com/fcm/send/x", keys: { p256dh: "BAAA", auth: p.auth } }, u.cookie);
    expect(r.status).toBe(400);
    expect((await db().prepare("SELECT COUNT(*) AS n FROM push_subs WHERE user_id = ?").bind(u.id).first<{ n: number }>())!.n).toBe(0);
  });

  it("a subscription belongs to its session: sign out removes it, and another person cannot take over a live one", async () => {
    const a = await makeUser("ps");
    const b = await makeUser("ps");
    const p = await subscribe(a);
    const again = await call("POST", "/api/push/subscription", { endpoint: p.endpoint, keys: { p256dh: p.p256dh, auth: p.auth } }, b.cookie);
    expect(again.status).toBe(409);
    expect((await db().prepare("SELECT user_id FROM push_subs WHERE endpoint = ?").bind(p.endpoint).first<{ user_id: number }>())!.user_id).toBe(a.id);
    await call("POST", "/api/logout", {}, a.cookie);
    expect(await db().prepare("SELECT 1 FROM push_subs WHERE endpoint = ?").bind(p.endpoint).first()).toBeNull();
  });

  it("a push service's 404 or 410 deletes the subscription; other errors keep it", async () => {
    const keys = await vapidKeys();
    for (const [status, kept] of [[410, false], [404, false], [500, true], [429, true]] as const) {
      const u = await makeUser("pg");
      const p = await subscribe(u);
      await spend(u, "2026-11-10", 50000);
      await dailyForUser({ DB: db(), APP_ORIGIN: ORIGIN, keys }, u.id, "es", stub(status).fetchFn, SUN_7PM);
      expect(!!(await db().prepare("SELECT 1 FROM push_subs WHERE endpoint = ?").bind(p.endpoint).first()), String(status)).toBe(kept);
    }
  });
});

describe("one notification per person per El Salvador day", () => {
  it("puts the most urgent item in the title (card, 100%, 80%, Sunday, cash) and the rest as short lines", async () => {
    const u = await makeUser("pp");
    const p = await subscribe(u);
    const keys = await vapidKeys();
    const penv: PushEnv = { DB: db(), APP_ORIGIN: ORIGIN, keys };
    // card due Dec 1 (2 days after SV Sunday Nov 29), Comida at 100%, it is Sunday, and the cash reminder is on
    await db().prepare("INSERT INTO cards (account_id, user_id, due_day, updated_at) VALUES (?, ?, 1, 1)").bind(u.accountId, u.id).run();
    await db().prepare("INSERT INTO alert_prefs (user_id, lim80, lim100, card_due, weekly, cash, updated_at) VALUES (?, 1, 1, 1, 1, 1, 1)").bind(u.id).run();
    await spend(u, "2026-11-05", 60000);
    const { sent, fetchFn } = stub();
    expect(await dailyForUser(penv, u.id, "es", fetchFn, SUN_7PM)).toBe("sent");
    const msg = JSON.parse(await decrypt(sent[0]!.body, p));
    expect(msg.title).toBe("Tu tarjeta BAC vence en 2 días");
    expect(msg.open).toBe("card");
    expect(msg.body.split("\n")).toEqual(["Comida llegó al 100% de su límite", "Tu resumen de la semana está listo", "y 1 más en la app"]);
    // a second run the same day sends nothing, whatever changed
    await spend(u, "2026-11-06", 100);
    expect(await dailyForUser(penv, u.id, "es", fetchFn, SUN_7PM + 60_000)).toBe("capped");
    expect(await dailyForUser(penv, u.id, "es", fetchFn, SUN_7PM + 4 * 3600_000)).toBe("capped"); // 11 pm SV, same day
    expect(sent).toHaveLength(1);
    expect((await db().prepare("SELECT COUNT(*) AS n FROM push_log WHERE user_id = ?").bind(u.id).first<{ n: number }>())!.n).toBe(1);
    // the next day: the card, the limit and the week were told; only the cash reminder (new day) is left
    const { sent: s2, fetchFn: f2 } = stub();
    expect(await dailyForUser(penv, u.id, "es", f2, SUN_7PM + DAY)).toBe("sent");
    expect(JSON.parse(await decrypt(s2[0]!.body, p)).title).toBe("¿Pagaste algo en efectivo hoy? Anótalo");
  });

  it("the card reminder goes once per statement: again only for the next due date", async () => {
    const u = await makeUser("pc");
    await subscribe(u);
    const keys = await vapidKeys();
    const penv: PushEnv = { DB: db(), APP_ORIGIN: ORIGIN, keys };
    await db().prepare("INSERT INTO cards (account_id, user_id, due_day, updated_at) VALUES (?, ?, 2, 1)").bind(u.accountId, u.id).run();
    await db().prepare("INSERT INTO alert_prefs (user_id, lim80, lim100, card_due, weekly, cash, updated_at) VALUES (?, 0, 0, 1, 0, 0, 1)").bind(u.id).run();
    const runs: string[] = [];
    // SV Nov 27 to Dec 2 (due Dec 2: 3 days before is Nov 29), then Dec 29 to Jan 2
    for (const start of [Date.UTC(2026, 10, 28, 1), Date.UTC(2026, 11, 30, 1)]) {
      for (let d = 0; d < 6; d++) runs.push(await dailyForUser(penv, u.id, "es", stub().fetchFn, start + d * DAY));
    }
    expect(runs).toEqual(["none", "none", "sent", "none", "none", "none", "none", "sent", "none", "none", "none", "none"]);
    // a statement's own due date wins over the due day
    await db().prepare("INSERT INTO card_statements (user_id, account_id, closing_date, due_date, source, created_at, updated_at) VALUES (?, ?, '2027-01-20', '2027-02-10', 'email', 1, 1)").bind(u.id, u.accountId).run();
    const { items } = await alertItems(db(), u.id, "es", Date.UTC(2027, 1, 8, 1));
    expect(items.map((i) => i.key)).toEqual([`card:${u.accountId}:2027-02-10`]);
  });

  it("each limit level goes once per group per month: 80%, then 100%, then nothing until next month", async () => {
    const u = await makeUser("pl");
    await subscribe(u);
    const keys = await vapidKeys();
    const penv: PushEnv = { DB: db(), APP_ORIGIN: ORIGIN, keys };
    await db().prepare("INSERT INTO alert_prefs (user_id, lim80, lim100, card_due, weekly, cash, updated_at) VALUES (?, 1, 1, 0, 0, 0, 1)").bind(u.id).run();
    const at = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d + 1, 1); // 7 pm SV on y-m-d
    const titles: (string | null)[] = [];
    const run = async (ms: number) => {
      const s = stub();
      const r = await dailyForUser(penv, u.id, "es", s.fetchFn, ms);
      titles.push(r === "sent" ? "sent" : null);
    };
    await spend(u, "2026-11-02", 41000); // 82%
    await run(at(2026, 11, 2));
    await run(at(2026, 11, 3));
    await spend(u, "2026-11-04", 10000); // 102%
    await run(at(2026, 11, 4));
    await run(at(2026, 11, 5));
    await spend(u, "2026-12-01", 45000); // December: 90%
    await run(at(2026, 12, 1));
    await run(at(2026, 12, 2));
    expect(titles).toEqual(["sent", null, "sent", null, "sent", null]);
    const keysSent = (await db().prepare("SELECT key FROM alert_marks WHERE user_id = ? AND pushed_day IS NOT NULL ORDER BY pushed_day").bind(u.id).all<{ key: string }>()).results.map((r) => r.key.replace(/:\d+:/, ":g:"));
    expect(keysSent).toEqual(["lim80:g:2026-11", "lim100:g:2026-11", "lim80:g:2026-12"]);
  });

  it("works out today and Sunday in El Salvador time (UTC-6), not UTC", async () => {
    expect(weekday("2026-11-29")).toBe(0);
    const u = await makeUser("pt");
    // 01:00 UTC Monday Nov 30 is 7 pm Sunday Nov 29 in El Salvador: the weekly summary is due
    expect((await alertItems(db(), u.id, "es", Date.UTC(2026, 10, 30, 1))).items.map((i) => i.key)).toEqual(["week:2026-11-29"]);
    // 01:00 UTC Sunday Nov 29 is still Saturday evening there: nothing
    expect((await alertItems(db(), u.id, "es", Date.UTC(2026, 10, 29, 1))).items).toEqual([]);
    // 05:59 UTC Dec 1 is still Nov 30 there: November's spending counts for November's limit
    await spend(u, "2026-11-30", 50000);
    expect((await alertItems(db(), u.id, "es", Date.UTC(2026, 11, 1, 5, 59))).items.map((i) => i.key)).toEqual([expect.stringMatching(/^lim100:\d+:2026-11$/)]);
    expect((await alertItems(db(), u.id, "es", Date.UTC(2026, 11, 1, 6, 0))).items).toEqual([]);
  });

  it("never puts an amount, a shop, a note or a card number in the notification", async () => {
    const u = await makeUser("pz");
    const p = await subscribe(u);
    const keys = await vapidKeys();
    await db().prepare("UPDATE groups SET name = 'Comida $500 <b>x</b> 4111' WHERE user_id = ?").bind(u.id).run();
    await db().prepare("UPDATE accounts SET name = 'VISA 4111-1111 Oro' WHERE id = ?").bind(u.accountId).run();
    await db().prepare("INSERT INTO cards (account_id, user_id, due_day, updated_at) VALUES (?, ?, 1, 1)").bind(u.accountId, u.id).run();
    await db().prepare("INSERT INTO alert_prefs (user_id, lim80, lim100, card_due, weekly, cash, updated_at) VALUES (?, 1, 1, 1, 1, 1, 1)").bind(u.id).run();
    await spend(u, "2026-11-12", 98765, "Farmacia Discreta Nota privada");
    const { sent, fetchFn } = stub();
    await dailyForUser({ DB: db(), APP_ORIGIN: ORIGIN, keys }, u.id, "en", fetchFn, SUN_7PM);
    const text = await decrypt(sent[0]!.body, p);
    const msg = JSON.parse(text);
    expect(Object.keys(msg).sort()).toEqual(["body", "open", "tag", "title"]);
    expect(msg.title).toBe("Your VISA card is due in 2 days");
    for (const bad of ["987", "98,765", "$", "4111", "1111", "Farmacia", "Discreta", "privada", "<b>", "Oro"]) expect(text, bad).not.toContain(bad);
    expect(text.replace(/100%|80%|2 days|1 more/g, "")).not.toMatch(/\d/);
  });

  it("the cron entry runs only on its schedule, and a deleted user gets nothing", async () => {
    const u = await makeUser("pd");
    const p = await subscribe(u);
    await spend(u, "2026-11-10", 50000);
    const keys = await vapidKeys();
    const s = stub();
    let waited: Promise<unknown> | null = null;
    const ctx = { waitUntil: (p: Promise<unknown>) => { waited = p; }, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
    await scheduled({ cron: "*/5 * * * *", scheduledTime: SUN_7PM, noRetry() {} } as ScheduledController, env, ctx);
    expect(waited).toBeNull();
    expect(DAILY_CRON).toBe("0 1 * * *");
    // without VAPID keys nothing is sent at all
    expect(await runDailyAlerts({ DB: db(), APP_ORIGIN: ORIGIN, keys: null }, SUN_7PM, s.fetchFn)).toBe(0);
    await db().prepare("DELETE FROM users WHERE id = ?").bind(u.id).run();
    await runDailyAlerts({ DB: db(), APP_ORIGIN: ORIGIN, keys }, SUN_7PM, s.fetchFn);
    expect(s.sent.some((r) => r.url === p.endpoint)).toBe(false);
    expect(await db().prepare("SELECT COUNT(*) AS n FROM push_log WHERE user_id = ?").bind(u.id).first<{ n: number }>()).toEqual({ n: 0 });
  });

  it("composes nothing when nothing is new, and banners come from the same items", async () => {
    expect(composeDaily([], "es")).toBeNull();
    const u = await makeUser("pb");
    await spend(u, new Date(Date.now() - 6 * 3600_000).toISOString().slice(0, 10), 45000);
    const b = await json(call("GET", "/api/alerts", undefined, u.cookie));
    const lim = b.items.find((i: { kind: string }) => i.kind === "lim80");
    expect(lim.text).toBe("Comida llegó al 80% de su límite");
    expect(lim.open).toBe("limit");
    expect((await call("POST", "/api/alerts/dismiss", { key: lim.key }, u.cookie)).status).toBe(200);
    expect((await json(call("GET", "/api/alerts", undefined, u.cookie))).items.some((i: { kind: string }) => i.kind === "lim80")).toBe(false);
    expect((await call("POST", "/api/alerts/dismiss", { key: "lim80:1:2026-11'--" }, u.cookie)).status).toBe(400);
  });
});
