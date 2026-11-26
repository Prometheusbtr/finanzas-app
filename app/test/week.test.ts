// Feature 3: weekly "Te quedan". Pure week math, the week read, the routes, and the monthly default left alone.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { merchantKey } from "../src/lib/merchant.ts";
import { derivedWeek, weekBounds, weekView } from "../src/lib/week.ts";
import { call, json, makeUser } from "./helpers.ts";

const db = () => env.DB;
const mov = (userId: number, fecha: string, cents: number, tipo: string, cat: number | null, comercio = "Shop") =>
  db().prepare(
    `INSERT INTO movements (user_id, fecha, amount_cents, tipo, comercio, merchant_key, category_id, origen, estado, dedupe_key, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'manual', 'ok', ?, 1, 1)`,
  ).bind(userId, fecha, cents, tipo, comercio, merchantKey(comercio), cat, `t:${Math.random()}`).run();

describe("weekBounds", () => {
  it("finds the week for each start day (Nov 25 2026 is a Wednesday)", () => {
    expect(weekBounds("2026-11-25", 1)).toEqual({ start: "2026-11-23", end: "2026-11-29", day: 3 });
    expect(weekBounds("2026-11-25", 0)).toEqual({ start: "2026-11-22", end: "2026-11-28", day: 4 });
    expect(weekBounds("2026-11-25", 3)).toEqual({ start: "2026-11-25", end: "2026-12-01", day: 1 });
    expect(weekBounds("2026-11-25", 4)).toEqual({ start: "2026-11-19", end: "2026-11-25", day: 7 });
    expect(weekBounds("2027-01-01", 1)).toEqual({ start: "2026-12-28", end: "2027-01-03", day: 5 });
  });
});

describe("derivedWeek", () => {
  const dates = (from: string) => Array.from({ length: 7 }, (_, i) => new Date(Date.parse(from + "T00:00:00Z") + i * 864e5).toISOString().slice(0, 10));
  it("counts a week across two months day by day", () => {
    // 1 day of November ($500/30) + 6 of December ($500/31) = $113.44 -> $113
    expect(derivedWeek(dates("2026-11-30"), 50000, new Map())).toBe(11300);
    // across the year: December and January both have 31 days
    expect(derivedWeek(dates("2026-12-28"), 50000, new Map())).toBe(11300);
    // November's fixed payments come off November's days only
    expect(derivedWeek(dates("2026-11-30"), 50000, new Map([["2026-11", 20000]]))).toBe(Math.round((30000 / 30 + (50000 / 31) * 6) / 100) * 100);
  });
  it("is null without limits", () => expect(derivedWeek(dates("2026-11-23"), 0, new Map())).toBe(null));
});

describe("weekView", () => {
  it("counts limited spending without fixed payments, and last week's result", async () => {
    const u = await makeUser("wk");
    const now = Date.now();
    await db().prepare(
      `INSERT INTO recurring (user_id, name, merchant_key, amount_cents, every, next_date, category_id, created_at, updated_at)
       VALUES (?, 'Netflix', ?, 1500, 'month', '2026-11-24', ?, ?, ?)`,
    ).bind(u.id, merchantKey("Netflix"), u.cats["Restaurantes"], now, now).run();
    await mov(u.id, "2026-11-24", 1000, "gasto", u.cats["Supermercado"]);
    await mov(u.id, "2026-11-24", 2000, "gasto", null); // no category: outside the limited groups
    await mov(u.id, "2026-11-25", 300, "abono", u.cats["Supermercado"]); // a refund subtracts
    await mov(u.id, "2026-11-24", 1500, "gasto", u.cats["Restaurantes"], "Netflix"); // pays the fixed payment
    await mov(u.id, "2026-11-26", 999, "gasto", u.cats["Supermercado"]); // tomorrow: not spent yet
    await mov(u.id, "2026-11-18", 4000, "gasto", u.cats["Restaurantes"]); // last week
    const v = await weekView(db(), u.id, "2026-11-25", { period: "week", week_cents: null, week_start: 1 });
    // ($500 limit - $15 Netflix) / 30 days * 7 = $113.17 -> $113
    expect(v).toEqual({
      start: "2026-11-23", end: "2026-11-29", day: 3, budget_cents: 11300, from: "limits", spent_cents: 700,
      last: { budget_cents: 11300, spent_cents: 4000 },
    });
    const own = await weekView(db(), u.id, "2026-11-25", { period: "week", week_cents: 20000, week_start: 1 });
    expect([own.budget_cents, own.from, own.last!.budget_cents]).toEqual([20000, "own", 20000]);
  });
  it("with no limits counts every purchase, and the budget is her own amount or none", async () => {
    const u = await makeUser("wkn");
    await db().prepare("UPDATE groups SET limit_cents = NULL WHERE user_id = ?").bind(u.id).run();
    await mov(u.id, "2026-11-24", 1000, "gasto", u.cats["Supermercado"]);
    await mov(u.id, "2026-11-24", 2000, "gasto", null);
    const v = await weekView(db(), u.id, "2026-11-25", { period: "week", week_cents: null, week_start: 1 });
    expect([v.budget_cents, v.from, v.spent_cents]).toEqual([null, null, 3000]);
  });
});

describe("budget routes", () => {
  it("no row = per month: bootstrap says month and Home extras has no week", async () => {
    const u = await makeUser("wkr");
    expect((await json(call("GET", "/api/bootstrap", undefined, u.cookie))).budget).toEqual({ period: "month", week_cents: null, week_start: 1 });
    const before = await json(call("GET", "/api/home/extras", undefined, u.cookie));
    const sumBefore = await json(call("GET", "/api/summary", undefined, u.cookie));
    expect("week" in before).toBe(false);
    // saving "per month" changes nothing on Home
    expect((await call("PUT", "/api/me/budget", { period: "month", week_cents: null, week_start: 1 }, u.cookie)).status).toBe(200);
    expect(await json(call("GET", "/api/home/extras", undefined, u.cookie))).toEqual(before);
    expect(await json(call("GET", "/api/summary", undefined, u.cookie))).toEqual(sumBefore);
  });
  it("per week: saved, shown in bootstrap and Home extras; another user is not touched", async () => {
    const a = await makeUser("wka");
    const b = await makeUser("wkb");
    const r = await call("PUT", "/api/me/budget", { period: "week", week_cents: 15000, week_start: 0 }, a.cookie);
    expect(await json(r)).toEqual({ budget: { period: "week", week_cents: 15000, week_start: 0 } });
    expect((await json(call("GET", "/api/bootstrap", undefined, a.cookie))).budget).toEqual({ period: "week", week_cents: 15000, week_start: 0 });
    const x = await json(call("GET", "/api/home/extras", undefined, a.cookie));
    expect(x.week.budget_cents).toBe(15000);
    expect(x.week.day).toBeGreaterThanOrEqual(1);
    // a past month never gets a week
    expect("week" in (await json(call("GET", "/api/home/extras?month=2025-01", undefined, a.cookie)))).toBe(false);
    const mine = await json(call("GET", "/api/me/budget", undefined, a.cookie));
    expect([mine.period, mine.week_cents, typeof mine.derived_week_cents]).toEqual(["week", 15000, "number"]);
    expect((await json(call("GET", "/api/me/budget", undefined, b.cookie))).period).toBe("month");
    expect("week" in (await json(call("GET", "/api/home/extras", undefined, b.cookie)))).toBe(false);
  });
  it("refuses bad input", async () => {
    const u = await makeUser("wkv");
    for (const body of [
      { period: "day", week_cents: null, week_start: 1 },
      { period: "week", week_cents: -1, week_start: 1 },
      { period: "week", week_cents: 10000001, week_start: 1 },
      { period: "week", week_cents: 1.5, week_start: 1 },
      { period: "week", week_cents: null, week_start: 7 },
      { period: "week", week_cents: null, week_start: 1, user_id: 1 },
      { period: "week" },
    ]) expect((await call("PUT", "/api/me/budget", body, u.cookie)).status).toBe(400);
    expect((await call("PUT", "/api/me/budget", { period: "week", week_cents: null, week_start: 1 })).status).toBe(401);
  });
});
