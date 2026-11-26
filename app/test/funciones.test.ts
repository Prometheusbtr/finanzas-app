// Funciones (Wave 2): Personas, Tarjetas, Recurrentes and other currencies. Cross-user refusal on every new id
// route, settle-up never counted as spending, splits, fixed payments counted once, USD totals with COP movements,
// and delete-my-account removing every new row.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { recordCardStatement } from "../src/lib/cards.ts";
import { svNow } from "../src/lib/dates.ts";
import { matchOccurrences, occurrences } from "../src/lib/upcoming.ts";
import { call, freshProof, json, makeUser, type TestUser } from "./helpers.ts";

const db = () => env.DB;
const today = () => svNow().fecha;
const month = () => today().slice(0, 7);
let cid = 0;
const clientId = () => `fz-test-${++cid}-${Math.random().toString(36).slice(2, 10)}`;

async function buy(u: TestUser, cents: number, extra: Record<string, unknown> = {}) {
  const r = await call("POST", "/api/movements", { client_id: clientId(), amount_cents: cents, comercio: "Super Uno", account_id: u.accountId, category_id: u.cats.Supermercado, ...extra }, u.cookie);
  expect(r.status).toBe(201);
  return (await r.json<{ movement: { id: number; fx: unknown } }>()).movement;
}
const summary = (u: TestUser, m = month()) => json(call("GET", `/api/summary?month=${m}`, undefined, u.cookie));
async function person(u: TestUser, name = "Ana") {
  const r = await call("POST", "/api/people", { name }, u.cookie);
  expect(r.status).toBe(201);
  return (await r.json<{ id: number }>()).id;
}
const balance = async (u: TestUser, id: number) => (await json(call("GET", `/api/people/${id}`, undefined, u.cookie))).person.balance_cents;

describe("Personas", () => {
  it("a split or a purchase for someone never changes spending; their part is what they owe", async () => {
    const u = await makeUser("fp");
    const ana = await person(u);
    const m = await buy(u, 4000);
    const before = await summary(u);
    expect((await call("POST", `/api/people/${ana}/share`, { movement_id: m.id, kind: "shared", cents: 2000 }, u.cookie)).status).toBe(201);
    expect(await balance(u, ana)).toBe(2000);
    // a share again on the same purchase replaces it (one per person), and shares never pass the purchase
    expect((await call("POST", `/api/people/${ana}/share`, { movement_id: m.id, kind: "paid_for", cents: 2500 }, u.cookie)).status).toBe(201);
    expect(await balance(u, ana)).toBe(2500);
    const leo = await person(u, "Leo");
    expect((await call("POST", `/api/people/${leo}/share`, { movement_id: m.id, kind: "shared", cents: 1600 }, u.cookie)).status).toBe(400);
    expect((await call("POST", `/api/people/${leo}/share`, { movement_id: m.id, kind: "shared", cents: 1500 }, u.cookie)).status).toBe(201);
    const after = await summary(u);
    expect(after.spent_cents).toBe(before.spent_cents);
    expect(after.limited_spent_cents).toBe(before.limited_spent_cents);
    const shares = await json(call("GET", `/api/people/movement/${m.id}`, undefined, u.cookie));
    expect(shares.shares.map((s: { name: string; cents: number }) => [s.name, s.cents])).toEqual([["Ana", 2500], ["Leo", 1500]]);
    // only purchases can be shared
    const inc = await call("POST", "/api/movements", { client_id: clientId(), amount_cents: 900, tipo: "ingreso", account_id: u.accountId }, u.cookie);
    expect((await call("POST", `/api/people/${ana}/share`, { movement_id: (await inc.json<any>()).movement.id, kind: "shared", cents: 100 }, u.cookie)).status).toBe(400);
  });

  it("Saldar is never spending or income; someone paying for her is her spending and her debt", async () => {
    const u = await makeUser("fs");
    const ana = await person(u);
    const m = await buy(u, 4000);
    await call("POST", `/api/people/${ana}/share`, { movement_id: m.id, kind: "shared", cents: 2000 }, u.cookie);
    const s0 = await summary(u);
    const settle = { client_id: clientId(), amount_cents: 2000, direction: "in", account_id: u.otherAccountId };
    const r = await call("POST", `/api/people/${ana}/settle`, settle, u.cookie);
    expect(r.status).toBe(201);
    // a retry of the same tap saves nothing more
    expect(await json(call("POST", `/api/people/${ana}/settle`, settle, u.cookie))).toEqual({ duplicate: true });
    const mv = await db().prepare("SELECT tipo, account_id, amount_cents FROM movements WHERE id = ?").bind((await r.json<any>()).movement_id).first();
    expect(mv).toEqual({ tipo: "interno", account_id: u.otherAccountId, amount_cents: 2000 });
    const s1 = await summary(u);
    expect([s1.spent_cents, s1.income_cents]).toEqual([s0.spent_cents, s0.income_cents]);
    expect(await balance(u, ana)).toBe(0);
    // Ana paid 1500 for her: spending goes up by 1500 (the purchase is hers), she owes 1500
    const tp = { client_id: clientId(), amount_cents: 1500, comercio: "Cine", category_id: u.cats.Restaurantes };
    expect((await call("POST", `/api/people/${ana}/they-paid`, tp, u.cookie)).status).toBe(201);
    expect(await json(call("POST", `/api/people/${ana}/they-paid`, tp, u.cookie))).toEqual({ duplicate: true });
    const s2 = await summary(u);
    expect(s2.spent_cents).toBe(s0.spent_cents + 1500);
    expect(await balance(u, ana)).toBe(-1500);
    // she pays Ana back, with no account: just the line
    expect((await call("POST", `/api/people/${ana}/settle`, { client_id: clientId(), amount_cents: 1500, direction: "out" }, u.cookie)).status).toBe(201);
    expect(await balance(u, ana)).toBe(0);
    expect((await summary(u)).spent_cents).toBe(s2.spent_cents);
    // removing the "they paid" line removes the purchase it made
    const detail = await json(call("GET", `/api/people/${ana}`, undefined, u.cookie));
    const line = detail.entries.find((e: { kind: string }) => e.kind === "they_paid");
    expect((await call("DELETE", `/api/people/${ana}/entries/${line.id}`, {}, u.cookie)).status).toBe(200);
    expect((await summary(u)).spent_cents).toBe(s0.spent_cents);
  });

  it("merging a typed purchase into its bank row keeps its Personas line on the bank row", async () => {
    const u = await makeUser("fm");
    const ana = await person(u);
    const typed = await buy(u, 3000);
    await call("POST", `/api/people/${ana}/share`, { movement_id: typed.id, kind: "shared", cents: 1500 }, u.cookie);
    const bank = await db().prepare(`INSERT INTO movements (user_id, fecha, amount_cents, tipo, comercio, merchant_key, account_id, origen, dedupe_key, created_at, updated_at)
      VALUES (?, ?, 3000, 'gasto', 'SUPER UNO', 'super uno', ?, 'correo BAC', ?, 1, 1) RETURNING id`).bind(u.id, today(), u.accountId, `bac:${clientId()}`).first<{ id: number }>();
    expect((await call("POST", `/api/movements/${typed.id}/merge`, { bank_id: bank!.id }, u.cookie)).status).toBe(200);
    const s = await json(call("GET", `/api/people/movement/${bank!.id}`, undefined, u.cookie));
    expect(s.shares.map((x: { cents: number }) => x.cents)).toEqual([1500]);
    expect(await balance(u, ana)).toBe(1500);
  });
});

describe("Tarjetas", () => {
  it("saves closing day, due day and limit for card accounts only, and records a statement for Step 3", async () => {
    const u = await makeUser("fc");
    expect((await call("PUT", `/api/cards/${u.accountId}`, { closing_day: 15, due_day: 5, limit_cents: 150000 }, u.cookie)).status).toBe(200);
    expect((await call("PUT", `/api/cards/${u.otherAccountId}`, { due_day: 5 }, u.cookie)).status).toBe(404); // cash, not a card
    expect((await call("PUT", `/api/cards/${u.accountId}`, { due_day: 32 }, u.cookie)).status).toBe(400);
    const c = (await json(call("GET", "/api/cards", undefined, u.cookie))).cards[0];
    expect([c.closing_day, c.due_day, c.limit_cents]).toEqual([15, 5, 150000]);
    expect(c.next_due.slice(8)).toBe("05");
    expect(c.next_closing.slice(8)).toBe("15");
    // the BAC email script's entry point: only this user's card accounts
    const other = await makeUser("fc");
    expect(await recordCardStatement(db(), other.id, u.accountId, { closing_date: "2026-11-15", due_date: "2026-12-05" }, "email")).toBe(false);
    expect(await recordCardStatement(db(), u.id, u.otherAccountId, { closing_date: "2026-11-15" }, "email")).toBe(false);
    expect(await recordCardStatement(db(), u.id, u.accountId, { closing_date: "2026-11-15", due_date: "2040-12-05", min_cents: 2500, full_cents: 40000 }, "email")).toBe(true);
    const c2 = (await json(call("GET", "/api/cards", undefined, u.cookie))).cards[0];
    expect(c2.statement).toEqual({ id: expect.any(Number), closing_date: "2026-11-15", due_date: "2040-12-05", min_cents: 2500, full_cents: 40000 });
    expect(c2.next_due).toBe("2040-12-05");
  });
});

describe("Recurrentes", () => {
  it("suggests repeated charges, keeps one, counts it once this month and stops when the real charge arrives", async () => {
    const u = await makeUser("fr");
    const t = today();
    const d = (days: number) => new Date(Date.parse(`${t}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
    for (const back of [90, 60, 30]) {
      await db().prepare(`INSERT INTO movements (user_id, fecha, amount_cents, tipo, comercio, merchant_key, account_id, category_id, origen, dedupe_key, created_at, updated_at)
        VALUES (?, ?, 1299, 'gasto', 'STREAMING UNO', 'streaming uno', ?, ?, 'correo BAC', ?, 1, 1)`).bind(u.id, d(-back), u.accountId, u.cats["Café y snacks"], `s:${back}:${clientId()}`).run();
    }
    const r0 = await json(call("GET", "/api/recurring", undefined, u.cookie));
    const sug = r0.suggestions.find((s: { merchant_key: string }) => s.merchant_key === "streaming uno");
    expect(sug).toBeTruthy();
    const ex0 = await json(call("GET", "/api/home/extras", undefined, u.cookie));
    expect(ex0.committed_cents).toBe(0);
    // she keeps it, due today
    const made = await call("POST", "/api/recurring", { name: "Streaming", amount_cents: 1299, every: "month", next_date: t, category_id: u.cats["Café y snacks"], merchant_key: "streaming uno" }, u.cookie);
    expect(made.status).toBe(201);
    const r1 = await json(call("GET", "/api/recurring", undefined, u.cookie));
    expect(r1.suggestions.some((s: { merchant_key: string }) => s.merchant_key === "streaming uno")).toBe(false);
    expect(r1.items[0].next_date).toBe(t);
    const s1 = await summary(u);
    const ex1 = await json(call("GET", "/api/home/extras", undefined, u.cookie));
    expect(ex1.committed_cents).toBe(1299);
    expect(ex1.committed_limited_cents).toBe(1299); // Comida has a limit
    expect(ex1.upcoming.map((x: { kind: string; fecha: string }) => [x.kind, x.fecha])).toEqual([["recurring", t]]);
    // the real charge arrives (a day late): spending counts it once, the plan no longer does
    await db().prepare(`INSERT INTO movements (user_id, fecha, amount_cents, tipo, comercio, merchant_key, account_id, category_id, origen, dedupe_key, created_at, updated_at)
      VALUES (?, ?, 1299, 'gasto', 'STREAMING UNO', 'streaming uno', ?, ?, 'correo BAC', ?, 1, 1)`).bind(u.id, t, u.accountId, u.cats["Café y snacks"], `s:now:${clientId()}`).run();
    const s2 = await summary(u);
    const ex2 = await json(call("GET", "/api/home/extras", undefined, u.cookie));
    expect(s2.spent_cents).toBe(s1.spent_cents + 1299);
    expect(ex2.committed_cents).toBe(0);
    expect(ex2.upcoming).toEqual([]);
    // "No es fijo" on another suggestion; delete switches the rule off for good
    expect((await call("POST", "/api/recurring/dismiss", { merchant_key: "otra cosa" }, u.cookie)).status).toBe(200);
    expect((await call("DELETE", `/api/recurring/${r1.items[0].id}`, {}, u.cookie)).status).toBe(200);
    expect((await json(call("GET", "/api/recurring", undefined, u.cookie))).items).toEqual([]);
  });

  it("Importar's kept answers become Recurrentes once; a deleted one does not come back", async () => {
    const u = await makeUser("fi");
    await db().prepare(`INSERT INTO movements (user_id, fecha, amount_cents, tipo, comercio, merchant_key, account_id, origen, dedupe_key, created_at, updated_at)
      VALUES (?, '2026-11-03', 2500, 'gasto', 'GIMNASIO UNO', 'gimnasio uno', ?, 'correo BAC', 'g1', 1, 1)`).bind(u.id, u.accountId).run();
    await db().prepare("INSERT INTO recurring_choices (user_id, merchant_key, keep, amount_cents, every_days, updated_at) VALUES (?, 'gimnasio uno', 1, 2500, 30, 1)").bind(u.id).run();
    const a = await json(call("GET", "/api/recurring", undefined, u.cookie));
    expect(a.items.map((i: { name: string; every: string; amount_cents: number }) => [i.name, i.every, i.amount_cents])).toEqual([["GIMNASIO UNO", "month", 2500]]);
    await json(call("GET", "/api/recurring", undefined, u.cookie));
    expect((await db().prepare("SELECT COUNT(*) AS n FROM recurring WHERE user_id = ?").bind(u.id).first<{ n: number }>())!.n).toBe(1);
    await call("DELETE", `/api/recurring/${a.items[0].id}`, {}, u.cookie);
    expect((await json(call("GET", "/api/recurring", undefined, u.cookie))).items).toEqual([]);
  });

  it("dates fall from the next date on, and each charge pays one date", () => {
    expect(occurrences({ every: "month", next_date: "2026-01-31" }, "2026-01-01", "2026-04-30")).toEqual(["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"]);
    expect(occurrences({ every: "2weeks", next_date: "2026-11-10" }, "2026-11-01", "2026-12-10")).toEqual(["2026-11-10", "2026-11-24", "2026-12-08"]);
    expect(occurrences({ every: "week", next_date: "2026-11-30" }, "2026-11-01", "2026-12-01")).toEqual(["2026-11-30"]);
    const rule = { id: 1, name: "x", merchant_key: "renta", amount_cents: 30000, every: "month" as const, next_date: "2026-10-01", account_id: null, category_id: null, active: 1 };
    const occ = matchOccurrences([rule], [{ id: 9, fecha: "2026-10-30", amount_cents: 30000, merchant_key: "renta", category_id: null }], "2026-10-01", "2026-11-30");
    // one charge on Oct 30 pays Nov 1 (closest), never both Oct 1 and Nov 1
    expect(occ.map((o) => [o.fecha, o.paid_by])).toEqual([["2026-10-01", null], ["2026-11-01", 9]]);
  });
});

describe("Moneda", () => {
  it("keeps the COP amount and rate beside the USD value; totals stay USD", async () => {
    const u = await makeUser("fx");
    const s0 = await summary(u);
    const m = await buy(u, 1000, { fx: { currency: "COP", cents: 4_000_000 } });
    expect(m.fx).toEqual({ currency: "COP", cents: 4_000_000, micros: 4_000_000_000, fee_cents: null });
    const s1 = await summary(u);
    expect(s1.spent_cents).toBe(s0.spent_cents + 1000);
    // a Wise send: USD sent with the fee, pesos received
    const w = await call("POST", "/api/movements", { client_id: clientId(), amount_cents: 10500, tipo: "interno", account_id: u.accountId, fx: { currency: "COP", cents: 40_000_000, fee_cents: 500 } }, u.cookie);
    expect((await w.json<any>()).movement.fx).toEqual({ currency: "COP", cents: 40_000_000, micros: 4_000_000_000, fee_cents: 500 });
    expect((await summary(u)).spent_cents).toBe(s1.spent_cents);
    // refused: a currency off the list, USD itself, a fee bigger than the amount, a float
    for (const fx of [{ currency: "XYZ", cents: 1 }, { currency: "USD", cents: 100 }, { currency: "COP", cents: 100, fee_cents: 2000 }, { currency: "COP", cents: 10.5 }]) {
      expect((await call("POST", "/api/movements", { client_id: clientId(), amount_cents: 1000, account_id: u.accountId, fx }, u.cookie)).status).toBe(400);
    }
    // the database refuses one too
    await expect(db().prepare("UPDATE movements SET orig_currency = 'ABC' WHERE id = ?").bind(m.id).run()).rejects.toThrow();
    // edit keeps it unless sent; null clears it
    await call("PUT", `/api/movements/${m.id}`, { nota: "x" }, u.cookie);
    expect((await json(call("GET", `/api/movements/${m.id}`, undefined, u.cookie))).movement.fx.currency).toBe("COP");
    await call("PUT", `/api/movements/${m.id}`, { fx: null }, u.cookie);
    expect((await json(call("GET", `/api/movements/${m.id}`, undefined, u.cookie))).movement.fx).toBeNull();
    // CSV keeps the formula guard on the new columns
    const csv = await (await call("GET", "/api/export.csv", undefined, u.cookie)).text();
    expect(csv.split("\r\n")[0]).toMatch(/,moneda,monto_moneda$/);
    expect(csv).toContain(",COP,400000.00");
  });
});

describe("cross-user: every new id route answers 404 for another person's id, and changes nothing", () => {
  it("people, entries, cards, statements, recurring, movement shares", async () => {
    const a = await makeUser("xa");
    const b = await makeUser("xb");
    const ana = await person(a);
    const mv = await buy(a, 3000);
    await call("POST", `/api/people/${ana}/share`, { movement_id: mv.id, kind: "shared", cents: 1000 }, a.cookie);
    const entry = (await json(call("GET", `/api/people/${ana}`, undefined, a.cookie))).entries[0].id;
    await call("PUT", `/api/cards/${a.accountId}`, { due_day: 5 }, a.cookie);
    const rec = (await json(call("POST", "/api/recurring", { name: "Renta", amount_cents: 30000, every: "month", next_date: today() }, a.cookie))).id;
    const bobPerson = await person(b, "Bea");
    const bobMv = await buy(b, 500);
    const snapshot = async () => JSON.stringify(await db().batch([
      db().prepare("SELECT * FROM people WHERE user_id = ?").bind(a.id), db().prepare("SELECT * FROM person_entries WHERE user_id = ?").bind(a.id),
      db().prepare("SELECT * FROM cards WHERE user_id = ?").bind(a.id), db().prepare("SELECT * FROM card_statements WHERE user_id = ?").bind(a.id),
      db().prepare("SELECT * FROM recurring WHERE user_id = ?").bind(a.id), db().prepare("SELECT * FROM movements WHERE user_id = ?").bind(a.id),
    ]).then((r) => r.map((x) => x.results)));
    const before = await snapshot();
    const tries: [string, string, unknown?][] = [
      ["GET", `/api/people/${ana}`], ["PUT", `/api/people/${ana}`, { name: "Eve" }],
      ["POST", `/api/people/${ana}/share`, { movement_id: bobMv.id, kind: "shared", cents: 100 }],
      ["POST", `/api/people/${bobPerson}/share`, { movement_id: mv.id, kind: "shared", cents: 100 }],
      ["POST", `/api/people/${ana}/they-paid`, { client_id: clientId(), amount_cents: 100 }],
      ["POST", `/api/people/${ana}/settle`, { client_id: clientId(), amount_cents: 100, direction: "in" }],
      ["DELETE", `/api/people/${ana}/entries/${entry}`, {}], ["DELETE", `/api/people/${bobPerson}/entries/${entry}`, {}],
      ["GET", `/api/people/movement/${mv.id}`],
      ["PUT", `/api/cards/${a.accountId}`, { due_day: 9 }], ["POST", `/api/cards/${a.accountId}/statement`, { closing_date: "2026-11-15" }],
      ["PUT", `/api/recurring/${rec}`, { amount_cents: 1 }], ["DELETE", `/api/recurring/${rec}`, {}],
    ];
    for (const [method, path, body] of tries) expect((await call(method, path, body, b.cookie)).status, `${method} ${path}`).toBe(404);
    // her ids as links in his own rows are refused too
    expect((await call("POST", "/api/recurring", { name: "X", amount_cents: 100, every: "month", next_date: today(), account_id: a.accountId }, b.cookie)).status).toBe(400);
    expect((await call("POST", `/api/people/${bobPerson}/settle`, { client_id: clientId(), amount_cents: 100, direction: "in", account_id: a.accountId }, b.cookie)).status).toBe(400);
    expect((await call("POST", `/api/people/${bobPerson}/they-paid`, { client_id: clientId(), amount_cents: 100, category_id: a.cats.Supermercado }, b.cookie)).status).toBe(400);
    // lists show only his own
    expect((await json(call("GET", "/api/people", undefined, b.cookie))).people.map((p: { name: string }) => p.name)).toEqual(["Bea"]);
    expect((await json(call("GET", "/api/cards", undefined, b.cookie))).cards.every((c: { account_id: number }) => c.account_id !== a.accountId)).toBe(true);
    expect((await json(call("GET", "/api/recurring", undefined, b.cookie))).items).toEqual([]);
    expect(await snapshot()).toBe(before);
    // and the database itself refuses a cross-user link
    await expect(db().prepare("INSERT INTO person_entries (user_id, person_id, kind, cents, fecha, created_at) VALUES (?, ?, 'settle', 1, '2026-11-01', 1)").bind(b.id, ana).run()).rejects.toThrow(/cross_user/);
    await expect(db().prepare("UPDATE recurring SET user_id = ? WHERE id = ?").bind(b.id, rec).run()).rejects.toThrow(/user_id_fixed/);
    await expect(db().prepare("INSERT INTO cards (account_id, user_id, updated_at) VALUES (?, ?, 1)").bind(a.otherAccountId, b.id).run()).rejects.toThrow(/cross_user/);
  });
});

describe("delete my account", () => {
  it("removes her rows from every new table", async () => {
    const u = await makeUser("fd");
    const ana = await person(u);
    const m = await buy(u, 2000, { fx: { currency: "COP", cents: 8_000_000 } });
    await call("POST", `/api/people/${ana}/share`, { movement_id: m.id, kind: "shared", cents: 1000 }, u.cookie);
    await call("PUT", `/api/cards/${u.accountId}`, { due_day: 5 }, u.cookie);
    await call("POST", `/api/cards/${u.accountId}/statement`, { closing_date: "2026-11-15", due_date: "2026-12-05" }, u.cookie);
    await call("POST", "/api/recurring", { name: "Renta", amount_cents: 30000, every: "month", next_date: today() }, u.cookie);
    await call("PUT", "/api/alerts/prefs", { cash: true }, u.cookie);
    await db().prepare("INSERT INTO alert_marks (user_id, key, dismissed_at) VALUES (?, 'week:2026-11-29', 1)").bind(u.id).run();
    await db().prepare("INSERT INTO push_log (user_id, day, slot, sent_at) VALUES (?, '2026-11-29', 'daily', 1)").bind(u.id).run();
    const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
    const p256dh = btoa(String.fromCharCode(...new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect((await call("POST", "/api/push/subscription", { endpoint: "https://fcm.googleapis.com/fcm/send/fz-del", keys: { p256dh, auth: "AAAAAAAAAAAAAAAAAAAAAA" } }, u.cookie)).status).toBe(201);
    const tables = ["people", "person_entries", "cards", "card_statements", "recurring", "alert_prefs", "push_subs", "push_log", "alert_marks"];
    for (const t of tables) expect((await db().prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE user_id = ?`).bind(u.id).first<{ n: number }>())!.n, t).toBeGreaterThan(0);
    const gone = await call("DELETE", "/api/me", { confirm: u.username }, u.cookie, { "cf-connecting-ip": "172.30.0.9", ...(await freshProof(u.cookie)) });
    expect(gone.status).toBe(200);
    for (const t of tables) expect((await db().prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE user_id = ?`).bind(u.id).first<{ n: number }>())!.n, t).toBe(0);
  });
});
