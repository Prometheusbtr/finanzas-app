// Seguridad review of Wave 5 (alerts, recurring, Personas edits, Nov 25 2026):
// 1. A "Saldar" line follows its transfer when the amount is fixed (like the they-paid line in F14). Before, the
//    person's balance kept the old amount.
// 2. F39: a rule's category stays in the Recurrentes sheet when its group (not only the category) is archived.
//    Before, the sheet showed "Ninguna" and the next save cleared the category.
// 3. Checks that held (kept as regressions): two evening runs at the same moment, one refused and one taken, deliver
//    the day's push exactly once; another user's movement gives 404 and never the 409 with her shares; editing the
//    shop, note or category of a split purchase is never blocked.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { dailyForUser, type PushEnv } from "../src/lib/alerts.ts";
import { b64u, type VapidKeys } from "../src/lib/webpush.ts";
import { call, json, makeUser, type TestUser } from "./helpers.ts";

const db = () => env.DB;
const ORIGIN = "https://finanzas.test";
const sv7pm = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d + 1, 1, 0);
let n = 0;
const cid = () => `sw5-${Date.now().toString(36)}-${++n}`;

async function vapidKeys(): Promise<VapidKeys> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  return { publicKey: b64u((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer), privateKey: ((await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey).d! };
}
async function subscribe(u: TestUser) {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const p256dh = b64u((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  const auth = b64u(crypto.getRandomValues(new Uint8Array(16)));
  const res = await call("POST", "/api/push/subscription", { endpoint: `https://web.push.apple.com/SW5-${Math.random().toString(36).slice(2)}`, keys: { p256dh, auth } }, u.cookie);
  expect(res.status).toBe(201);
}

describe("Seguridad W5: Personas lines follow an edited movement", () => {
  it("a settle-up line follows its transfer's new amount (money in stays negative, out positive)", async () => {
    const u = await makeUser("sw5set");
    const p = await json(call("POST", "/api/people", { name: "Person S" }, u.cookie));
    const inn = await json(call("POST", `/api/people/${p.id}/settle`, { client_id: cid(), amount_cents: 2000, direction: "in", account_id: u.accountId }, u.cookie));
    const out = await json(call("POST", `/api/people/${p.id}/settle`, { client_id: cid(), amount_cents: 500, direction: "out", account_id: u.accountId }, u.cookie));
    expect((await json(call("GET", `/api/people/${p.id}`, undefined, u.cookie))).person.balance_cents).toBe(-2000 + 500);
    expect((await call("PUT", `/api/movements/${inn.movement_id}`, { amount_cents: 2500 }, u.cookie)).status).toBe(200);
    expect((await call("PUT", `/api/movements/${out.movement_id}`, { amount_cents: 700 }, u.cookie)).status).toBe(200);
    expect((await json(call("GET", `/api/people/${p.id}`, undefined, u.cookie))).person.balance_cents).toBe(-2500 + 700);
    // a note edit on a settle-up changes nothing
    expect((await call("PUT", `/api/movements/${inn.movement_id}`, { nota: "fixed" }, u.cookie)).status).toBe(200);
    expect((await json(call("GET", `/api/people/${p.id}`, undefined, u.cookie))).person.balance_cents).toBe(-2500 + 700);
  });

  it("a split purchase: shop, note, category and date edits pass; another user's edit is a 404 with no shares in it", async () => {
    const u = await makeUser("sw5shr");
    const bob = await makeUser("sw5bob");
    const m = (await json(call("POST", "/api/movements", { client_id: cid(), amount_cents: 1000, account_id: u.accountId, comercio: "Shop Q" }, u.cookie))).movement;
    const p = await json(call("POST", "/api/people", { name: "Person Q" }, u.cookie));
    expect((await call("POST", `/api/people/${p.id}/share`, { movement_id: m.id, kind: "paid_for", cents: 1000 }, u.cookie)).status).toBe(201);
    const edit = { amount_cents: 1000, tipo: "gasto", comercio: "Shop Q2", nota: "n", category_id: u.cats["Restaurantes"], fecha: m.fecha };
    expect((await call("PUT", `/api/movements/${m.id}`, edit, u.cookie)).status).toBe(200);
    const theirs = await call("PUT", `/api/movements/${m.id}`, { amount_cents: 1 }, bob.cookie);
    expect(theirs.status).toBe(404);
    expect(await theirs.text()).not.toContain("shares");
    expect((await call("PUT", `/api/movements/${m.id}`, { amount_cents: 999 }, u.cookie)).status).toBe(409);
  });
});

describe("Seguridad W5: the evening push, two runs at once", () => {
  it("one refused and one taken at the same moment deliver the day's push exactly once, and a failure is retried", async () => {
    const u = await makeUser("sw5push");
    await subscribe(u);
    const penv: PushEnv = { DB: db(), APP_ORIGIN: ORIGIN, keys: await vapidKeys() };
    await db().prepare("INSERT INTO cards (account_id, user_id, due_day, updated_at) VALUES (?, ?, 1, 1)").bind(u.accountId, u.id).run();
    await db().prepare("INSERT INTO alert_prefs (user_id, lim80, lim100, card_due, weekly, cash, updated_at) VALUES (?, 0, 0, 1, 0, 0, 1)").bind(u.id).run();
    const now = sv7pm(2026, 11, 28);
    let taken = 0;
    const down = async () => new Response(null, { status: 503 });
    const up = async () => (taken++, new Response(null, { status: 201 }));
    const [a, b] = await Promise.all([dailyForUser(penv, u.id, "es", down, now), dailyForUser(penv, u.id, "es", up, now)]);
    const third = await dailyForUser(penv, u.id, "es", up, now + 60_000);
    const fourth = await dailyForUser(penv, u.id, "es", up, now + 120_000);
    expect(taken).toBe(1);
    expect([a, b, third, fourth].filter((s) => s === "sent").length).toBe(1);
    expect(fourth).not.toBe("sent");
    const log = await db().prepare("SELECT COUNT(*) AS n FROM push_log WHERE user_id = ? AND slot = 'daily'").bind(u.id).first<{ n: number }>();
    expect(log!.n).toBe(1);
  });
});

describe("Seguridad W5: F39 Recurrentes keeps the rule's own category and account", () => {
  it("a category in an archived group, an archived category and an archived account stay in the lists", async () => {
    (globalThis as { document?: unknown }).document ??= { getElementById: () => null };
    // @ts-ignore plain browser module without types
    const { S } = await import("../public/js/state.js");
    // @ts-ignore plain browser module without types
    const data = await import("../public/js/data.js");
    S.boot = {
      groups: [{ id: 1, name: "Live", archived: 0 }, { id: 2, name: "Old", archived: 1 }],
      categories: [
        { id: 10, group_id: 1, name: "A", archived: 0 },
        { id: 11, group_id: 1, name: "B", archived: 1 },
        { id: 20, group_id: 2, name: "C", archived: 0 },
      ],
      accounts: [{ id: 5, name: "Cash", archived: 0 }, { id: 6, name: "Old card", archived: 1 }],
    };
    expect(typeof data.catsWith).toBe("function");
    const ids = (l: { id: number }[]) => l.map((x) => x.id);
    expect(ids(data.catsWith(20))).toEqual([10, 20]); // the group is archived, the category is not
    expect(ids(data.catsWith(11))).toEqual([10, 11]);
    expect(ids(data.catsWith(10))).toEqual([10]);
    expect(ids(data.catsWith(null))).toEqual([10]);
    expect(ids(data.accountsWith(6))).toEqual([5, 6]);
    expect(ids(data.accountsWith(null))).toEqual([5]);
    S.boot = null;
  });
});
