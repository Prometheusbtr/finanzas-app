// AUDIT (MONEY area): reproductions of money and date bugs. Each test asserts the CURRENT behavior at HEAD d254b3f
// so it passes while the bug is present; the comment says what the correct value would be. Flip the expectations
// when fixing. Synthetic users only (fresh D1 per run).
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { lastClosing, type CardRow } from "../src/lib/cards.ts";
import { shiftDays, svNow } from "../src/lib/dates.ts";
import { occurrences } from "../src/lib/upcoming.ts";
import { call, json, makeUser } from "./helpers.ts";

const db = () => env.DB;
const cid = () => crypto.randomUUID().replace(/-/g, "");
const addMonth = (f: string, n: number) => {
  const d = new Date(Date.UTC(Number(f.slice(0, 4)), Number(f.slice(5, 7)) - 1 + n, Number(f.slice(8, 10))));
  return d.toISOString().slice(0, 10);
};

describe("AUDIT MONEY", () => {
  it("F08 (fixed) lastClosing (pure): the scheduled closing beats an older statement", () => {
    const card: CardRow = { account_id: 1, name: "Card A", closing_day: 12, due_day: 25, limit_cents: null, st_id: 1, st_closing: "2026-10-12", st_due: "2026-10-25", st_min: null, st_full: null, imp_closing: null };
    expect(lastClosing(card, "2026-11-25")).toBe("2026-11-12");
    expect(lastClosing({ ...card, st_closing: null }, "2026-11-25")).toBe("2026-11-12");
  });

  it("F08 (fixed) GET /cards: cycle spending holds only this cycle", async () => {
    const u = await makeUser("mf7");
    const today = svNow().fecha;
    let off = 10;
    while (Number(shiftDays(today, -off).slice(8)) > 28) off++;
    const sched = shiftDays(today, -off); // the scheduled closing this month (or last)
    const day = Number(sched.slice(8));
    const oldSt = addMonth(sched, -1);
    expect((await call("PUT", `/api/cards/${u.accountId}`, { closing_day: day, due_day: 28 }, u.cookie)).status).toBe(200);
    expect((await call("POST", `/api/cards/${u.accountId}/statement`, { closing_date: oldSt }, u.cookie)).status).toBe(200);
    await call("POST", "/api/movements", { client_id: cid(), amount_cents: 1000, account_id: u.accountId, fecha: shiftDays(sched, -1), comercio: "Shop A" }, u.cookie);
    await call("POST", "/api/movements", { client_id: cid(), amount_cents: 234, account_id: u.accountId, fecha: shiftDays(today, -1), comercio: "Shop B" }, u.cookie);
    const k = (await json(call("GET", "/api/cards", undefined, u.cookie))).cards.find((c: any) => c.account_id === u.accountId);
    console.log("F07", JSON.stringify({ today, sched, oldSt, last_closing: k.last_closing, cycle: k.cycle_spent_cents }));
    expect(k.last_closing).toBe(sched);
    expect(k.cycle_spent_cents).toBe(234);
  });

  it("F13 (fixed) a charge on another account does not pay a recurring rule tied to a card; one on the card does", async () => {
    const u = await makeUser("mf9");
    const today = svNow().fecha;
    const made = await json(call("POST", "/api/recurring", { name: "QA Orbit", amount_cents: 1700, every: "month", next_date: today, account_id: u.accountId }, u.cookie));
    const before = (await json(call("GET", "/api/recurring", undefined, u.cookie))).items.find((x: any) => x.id === made.id);
    await call("POST", "/api/movements", { client_id: cid(), amount_cents: 1700, account_id: u.otherAccountId, fecha: today, comercio: "QA Orbit" }, u.cookie);
    const after = (await json(call("GET", "/api/recurring", undefined, u.cookie))).items.find((x: any) => x.id === made.id);
    console.log("F09", JSON.stringify({ before: before.next_date, after: after.next_date, last_paid: after.last_paid }));
    expect(before.next_date).toBe(today);
    expect(after.last_paid).toBe(null); // the charge was on the other account, not the card
    expect(after.next_date).toBe(today);
    await call("POST", "/api/movements", { client_id: cid(), amount_cents: 1700, account_id: u.accountId, fecha: today, comercio: "QA Orbit" }, u.cookie);
    const paid = (await json(call("GET", "/api/recurring", undefined, u.cookie))).items.find((x: any) => x.id === made.id);
    expect(paid.last_paid).toBe(today);
  });

  it("F14 (fixed) an edit below the shares or away from gasto asks first; a they-paid line follows the new amount", async () => {
    const u = await makeUser("mf10");
    const today = svNow().fecha;
    const m = (await json(call("POST", "/api/movements", { client_id: cid(), amount_cents: 1234, account_id: u.accountId, fecha: today, comercio: "Shop A", category_id: u.cats["Restaurantes"] }, u.cookie))).movement;
    const p = await json(call("POST", "/api/people", { name: "Person A" }, u.cookie));
    expect((await call("POST", `/api/people/${p.id}/share`, { movement_id: m.id, kind: "shared", cents: 1000 }, u.cookie)).status).toBe(201);
    const low = await call("PUT", `/api/movements/${m.id}`, { amount_cents: 500 }, u.cookie);
    expect(low.status).toBe(409);
    expect(await low.json()).toEqual({ error: "has_shares", shares_cents: 1000 });
    expect((await call("PUT", `/api/movements/${m.id}`, { amount_cents: 1000 }, u.cookie)).status).toBe(200); // still fits
    expect((await call("PUT", `/api/movements/${m.id}`, { tipo: "interno" }, u.cookie)).status).toBe(409);
    expect((await call("PUT", `/api/movements/${m.id}`, { nota: "ok" }, u.cookie)).status).toBe(200); // other fields are free
    let person = (await json(call("GET", `/api/people/${p.id}`, undefined, u.cookie))).person;
    expect(person.balance_cents).toBe(1000);
    // they paid $20.00 for me, then I fix the purchase to $25.00: I owe $25.00
    const tp = await json(call("POST", `/api/people/${p.id}/they-paid`, { client_id: cid(), amount_cents: 2000, comercio: "Shop B" }, u.cookie));
    expect((await call("PUT", `/api/movements/${tp.movement.id}`, { amount_cents: 2500 }, u.cookie)).status).toBe(200);
    person = (await json(call("GET", `/api/people/${p.id}`, undefined, u.cookie))).person;
    expect(person.balance_cents).toBe(1000 - 2500);
    expect((await call("PUT", `/api/movements/${tp.movement.id}`, { tipo: "ignorado" }, u.cookie)).status).toBe(409);
  });

  it("F16 (fixed) rec_anchor: an edit that leaves the date alone keeps the stored day (a day-31 rule stays on the 31st)", async () => {
    const u = await makeUser("mra");
    const today = svNow().fecha;
    // the latest 31st that is more than a week before today
    let anchor = "";
    for (let k = 0; k < 14 && !anchor; k++) {
      const first = addMonth(today.slice(0, 7) + "-01", -k);
      const end = new Date(Date.UTC(Number(first.slice(0, 4)), Number(first.slice(5, 7)), 0)).toISOString().slice(0, 10);
      if (end.endsWith("-31") && end < shiftDays(today, -7)) anchor = end;
    }
    const made = await json(call("POST", "/api/recurring", { name: "QA Rent", amount_cents: 50000, every: "month", next_date: anchor }, u.cookie));
    const item = (await json(call("GET", "/api/recurring", undefined, u.cookie))).items.find((x: any) => x.id === made.id);
    // what recurrentes.js does now: the shown date was not changed, so it is not sent
    expect((await call("PUT", `/api/recurring/${made.id}`, { name: "QA Rent 2", amount_cents: 50000, every: "month", account_id: null, category_id: null }, u.cookie)).status).toBe(200);
    const stored = (await db().prepare("SELECT next_date FROM recurring WHERE id = ?").bind(made.id).first<{ next_date: string }>())!.next_date;
    // the next month with 31 days after the stored date
    let m31 = "";
    for (let k = 1; k < 13 && !m31; k++) {
      const first = addMonth(stored.slice(0, 7) + "-01", k);
      const end = new Date(Date.UTC(Number(first.slice(0, 4)), Number(first.slice(5, 7)), 0)).toISOString().slice(0, 10);
      if (end.endsWith("-31")) m31 = end;
    }
    const occ = occurrences({ every: "month", next_date: stored }, m31.slice(0, 8) + "01", m31);
    console.log("rec_anchor", JSON.stringify({ anchor, shown: item.next_date, stored, next31Month: occ }));
    expect(stored).toBe(anchor); // the anchor (day 31) is kept
    expect(occ[0]!.endsWith("-31")).toBe(true);
  });

  it("F40 (fixed) PUT /movements with amount 0 and an fx without rate is a 400", async () => {
    const u = await makeUser("mz");
    const m = (await json(call("POST", "/api/movements", { client_id: cid(), amount_cents: 1000, account_id: u.accountId, comercio: "Shop A" }, u.cookie))).movement;
    const r = await call("PUT", `/api/movements/${m.id}`, { amount_cents: 0, fx: { currency: "CAD", cents: 1250 } }, u.cookie);
    console.log("zero_fx", r.status);
    expect(r.status).toBe(400);
  });
});
