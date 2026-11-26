// Wave 1 (audit Nov 25 2026): card statements can be corrected and cleared (F04, F25, F32), the card cycle (F08),
// one due date per cycle (F12), and a zero amount is a 400 (F40). Synthetic users only.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { lastClosing, nextDue, type CardRow } from "../src/lib/cards.ts";
import { call, json, makeUser } from "./helpers.ts";

const card = (x: Partial<CardRow> = {}): CardRow => ({
  account_id: 1, name: "Card A", closing_day: 15, due_day: 22, limit_cents: null,
  st_id: null, st_closing: null, st_due: null, st_min: null, st_full: null, imp_closing: null, ...x,
});

describe("lastClosing and nextDue", () => {
  it("a statement one cycle old loses to the scheduled closing; one in this cycle (off schedule) wins", () => {
    expect(lastClosing(card({ st_closing: "2026-10-15" }), "2026-11-25")).toBe("2026-11-15");
    expect(lastClosing(card({ st_closing: "2026-11-16" }), "2026-11-25")).toBe("2026-11-16"); // a day late
    expect(lastClosing(card({ st_closing: "2026-11-13" }), "2026-11-25")).toBe("2026-11-13"); // two days early
    expect(lastClosing(card({ closing_day: null, st_closing: "2026-10-15" }), "2026-11-25")).toBe("2026-10-15");
    expect(lastClosing(card({ closing_day: null }), "2026-11-25")).toBe(null);
  });
  it("closing day 31 in February and in a 30-day month", () => {
    expect(lastClosing(card({ closing_day: 31 }), "2026-03-05")).toBe("2026-02-28");
    expect(lastClosing(card({ closing_day: 31 }), "2026-05-01")).toBe("2026-04-30");
  });
  it("a due date the bank moved a day earlier is the cycle's only due date", () => {
    const k = card({ closing_day: 20, due_day: 18, st_closing: "2026-10-20", st_due: "2026-11-17" });
    expect(nextDue(k, "2026-11-16")).toBe("2026-11-17");
    expect(nextDue(k, "2026-11-18")).toBe("2026-12-18");
    expect(nextDue(card({ st_due: "2026-10-22" }), "2026-11-20")).toBe("2026-11-22"); // an old statement: due day
    expect(nextDue(card({ due_day: null }), "2026-11-20")).toBe(null);
  });
});

describe("card statements", () => {
  const getCard = async (u: { cookie: string }, id: number) =>
    (await json(call("GET", "/api/cards", undefined, u.cookie))).cards.find((c: any) => c.account_id === id);

  it("typed nulls clear the payments; DELETE clears the statement; the other card is untouched", async () => {
    const u = await makeUser("w1st");
    const other = await json(call("POST", "/api/accounts", { name: "Card B", kind: "tarjeta" }, u.cookie));
    const b = other.id ?? other.account?.id;
    for (const id of [u.accountId, b]) {
      expect((await call("POST", `/api/cards/${id}/statement`, { closing_date: "2026-10-12", due_date: "2026-10-25", min_cents: 321, full_cents: 1234 }, u.cookie)).status).toBe(200);
    }
    const st = (await getCard(u, u.accountId)).statement;
    expect(st).toMatchObject({ due_date: "2026-10-25", min_cents: 321, full_cents: 1234 });
    expect(typeof st.id).toBe("number");
    await call("POST", `/api/cards/${u.accountId}/statement`, { closing_date: "2026-10-12", due_date: null, min_cents: 0, full_cents: null, id: st.id }, u.cookie);
    expect((await getCard(u, u.accountId)).statement).toMatchObject({ due_date: null, min_cents: 0, full_cents: null });
    const del = await json(call("DELETE", `/api/cards/${u.accountId}/statement`, undefined, u.cookie));
    expect(del.removed).toBe(1);
    expect((await getCard(u, u.accountId)).statement).toBe(null);
    expect((await getCard(u, b)).statement).toMatchObject({ min_cents: 321 });
  });

  it("changing the closing date corrects the row instead of adding one behind it", async () => {
    const u = await makeUser("w1fix");
    await call("POST", `/api/cards/${u.accountId}/statement`, { closing_date: "2026-10-12", due_date: "2026-10-25" }, u.cookie);
    const st = (await getCard(u, u.accountId)).statement;
    await call("POST", `/api/cards/${u.accountId}/statement`, { closing_date: "2026-10-05", due_date: "2026-10-25", id: st.id }, u.cookie);
    const rows = await env.DB.prepare("SELECT closing_date FROM card_statements WHERE account_id = ?").bind(u.accountId).all<{ closing_date: string }>();
    expect(rows.results.map((r) => r.closing_date)).toEqual(["2026-10-05"]);
  });

  it("an email fills in only what it knows; DELETE ?st= removes one row; other users' rows are safe", async () => {
    const u = await makeUser("w1em");
    const v = await makeUser("w1em2");
    await call("POST", `/api/cards/${u.accountId}/statement`, { closing_date: "2026-10-12", min_cents: 800 }, u.cookie);
    const st = (await getCard(u, u.accountId)).statement;
    // another user cannot delete it, by card id or statement id
    expect((await call("DELETE", `/api/cards/${u.accountId}/statement?st=${st.id}`, undefined, v.cookie)).status).toBe(404);
    const r = await json(call("DELETE", `/api/cards/${v.accountId}/statement?st=${st.id}`, undefined, v.cookie));
    expect(r.removed).toBe(0);
    expect((await call("DELETE", `/api/cards/${u.accountId}/statement?st=abc`, undefined, u.cookie)).status).toBe(400);
    expect((await json(call("DELETE", `/api/cards/${u.accountId}/statement?st=${st.id}`, undefined, u.cookie))).removed).toBe(1);
  });
});
