// Seguridad review of Wave 1 (cards and money, Nov 25 2026): the statement id and the new DELETE cannot reach
// another user's rows, or another card's rows, by any id combination; odd ids are a 400, never a 500.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { parseRate } from "../public/js/numbers.js";
import { call, json, makeUser } from "./helpers.ts";

const rows = async (accountId: number) =>
  (await env.DB.prepare("SELECT id, closing_date, due_date, min_cents FROM card_statements WHERE account_id = ? ORDER BY id").bind(accountId)
    .all<{ id: number; closing_date: string; due_date: string | null; min_cents: number | null }>()).results;
const stId = async (u: { cookie: string }, accountId: number) =>
  (await json(call("GET", "/api/cards", undefined, u.cookie))).cards.find((c: any) => c.account_id === accountId).statement.id as number;

describe("card statements across users and cards", () => {
  it("bob cannot change or delete alice's statement through his card, her card, or the statement id", async () => {
    const a = await makeUser("sega");
    const b = await makeUser("segb");
    for (const [u, min] of [[a, 111], [b, 222]] as const) {
      expect((await call("POST", `/api/cards/${u.accountId}/statement`, { closing_date: "2026-10-12", due_date: "2026-10-25", min_cents: min }, u.cookie)).status).toBe(200);
    }
    const aSt = await stId(a, a.accountId);
    const before = await rows(a.accountId);

    // her card: 404 for every write
    expect((await call("POST", `/api/cards/${a.accountId}/statement`, { closing_date: "2026-10-01", id: aSt }, b.cookie)).status).toBe(404);
    expect((await call("DELETE", `/api/cards/${a.accountId}/statement`, undefined, b.cookie)).status).toBe(404);
    expect((await call("DELETE", `/api/cards/${a.accountId}/statement?st=${aSt}`, undefined, b.cookie)).status).toBe(404);
    // his card with her statement id: his own row is written, hers stays
    expect((await call("POST", `/api/cards/${b.accountId}/statement`, { closing_date: "2026-10-01", min_cents: 5, id: aSt }, b.cookie)).status).toBe(200);
    expect((await json(call("DELETE", `/api/cards/${b.accountId}/statement?st=${aSt}`, undefined, b.cookie))).removed).toBe(0);
    // his non-card account and an id that is not an account
    expect((await call("DELETE", `/api/cards/${b.otherAccountId}/statement`, undefined, b.cookie)).status).toBe(404);
    expect((await call("DELETE", `/api/cards/999999999/statement`, undefined, b.cookie)).status).toBe(404);

    expect(await rows(a.accountId)).toEqual(before);
    expect((await rows(b.accountId)).map((r) => r.closing_date).sort()).toEqual(["2026-10-01", "2026-10-12"]);
  });

  it("her statement id on her other card never touches the first card's row", async () => {
    const a = await makeUser("segc");
    const card2 = await json(call("POST", "/api/accounts", { name: "Card B", kind: "tarjeta" }, a.cookie));
    const c2 = card2.id ?? card2.account?.id;
    await call("POST", `/api/cards/${a.accountId}/statement`, { closing_date: "2026-10-12", min_cents: 111 }, a.cookie);
    const s1 = await stId(a, a.accountId);
    const before = await rows(a.accountId);
    expect((await call("POST", `/api/cards/${c2}/statement`, { closing_date: "2026-10-05", id: s1 }, a.cookie)).status).toBe(200);
    expect((await json(call("DELETE", `/api/cards/${c2}/statement?st=${s1}`, undefined, a.cookie))).removed).toBe(0);
    expect(await rows(a.accountId)).toEqual(before);
    expect((await rows(c2)).map((r) => r.closing_date)).toEqual(["2026-10-05"]);
  });

  it("odd statement ids are a 400, never a 500, and change nothing", async () => {
    const a = await makeUser("segd");
    await call("POST", `/api/cards/${a.accountId}/statement`, { closing_date: "2026-10-12", min_cents: 111 }, a.cookie);
    const before = await rows(a.accountId);
    for (const id of [0, -1, 1.5, "1", 1e20, 2 ** 53, true, [1], { x: 1 }]) {
      const r = await call("POST", `/api/cards/${a.accountId}/statement`, { closing_date: "2026-10-01", id }, a.cookie);
      expect(r.status, JSON.stringify(id)).toBe(400);
    }
    for (const st of ["0", "-1", "1.5", "1e3", "", "%20", "abc", "99999999999999999", "1&st=2"]) {
      const r = await call("DELETE", `/api/cards/${a.accountId}/statement?st=${st}`, undefined, a.cookie);
      expect(r.status, st).toBeLessThan(500);
      if (st !== "1&st=2") expect([400], st).toContain(r.status);
    }
    // the largest id the pattern lets through reaches the database without a 500
    expect((await call("DELETE", `/api/cards/${a.accountId}/statement?st=9999999999999999`, undefined, a.cookie)).status).toBeLessThan(500);
    expect(await rows(a.accountId)).toEqual(before);
  });
});

describe("parseRate: a comma with three digits after it", () => {
  it("a leading zero is always a decimal comma (0,925 is 0.925, never 925)", () => {
    expect(parseRate("0,925", "EUR")).toEqual({ rate: 0.925 });
    expect(parseRate("0,792", "GBP")).toEqual({ rate: 0.792 });
  });
  it("for a currency whose rate is small, 1,385 is not guessed as 1385", () => {
    expect(parseRate("1,385", "CAD")).toEqual({ error: "fnFxBadRate" });
    expect(parseRate("18,250", "MXN")).toEqual({ error: "fnFxBadRate" });
    // unambiguous shapes still work
    expect(parseRate("1,38", "CAD")).toEqual({ rate: 1.38 });
    expect(parseRate("1,3850", "CAD")).toEqual({ rate: 1.385 });
    expect(parseRate("1.385", "CAD")).toEqual({ rate: 1.385 });
  });
  it("CRC (about 500 a dollar) reads a 3-decimal dot rate as decimals, so an old movement saves again unchanged", () => {
    expect(parseRate("512.125", "CRC")).toEqual({ rate: 512.125 });
    expect(parseRate("512.500", "CRC")).toEqual({ rate: 512.5 });
    expect(parseRate("512,500", "CRC")).toEqual({ error: "fnFxBadRate" });
  });
  it("COP keeps comma thousands", () => {
    expect(parseRate("4,400", "COP")).toEqual({ rate: 4400 });
    expect(parseRate("4,400.50", "COP")).toEqual({ rate: 4400.5 });
    expect(parseRate("1,234,567", "COP")).toEqual({ rate: 1234567 });
  });
});
