// Seguridad review of Wave 2 (import, Nov 25 2026): one part is one transaction including its claim, a merge is the
// same as the old mergeManualIntoBank, a key collision never touches the typed row, and undo's hand-over stays
// with this user and keeps every import's counts true.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import app from "../src/index.ts";
import { saveChunk } from "../src/lib/importing.ts";
import { BASE, call, json, makeUser, type TestUser } from "./helpers.ts";

type Row = { fecha: string; comercio?: string; cents: number; dir: "out" | "in" };
const db = () => env.DB;
const ROWS: Row[] = [
  { fecha: "2026-10-05", comercio: "SEG Shop A", cents: 1234, dir: "out" },
  { fecha: "2026-10-06", comercio: "SEG Shop B", cents: 500, dir: "out" },
];

async function start(u: TestUser, source = "bac_tc") {
  const r = await call("POST", "/api/imports", { account_id: u.accountId, source, balanced: false, period_start: "2026-10-01", period_end: "2026-10-30" }, u.cookie);
  expect(r.status).toBe(201);
  return (await json<{ id: number }>(r)).id;
}
async function imp(u: TestUser, rows: Row[] = ROWS, source = "bac_tc") {
  const id = await start(u, source);
  expect((await call("POST", `/api/imports/${id}/rows`, { part: 0, rows }, u.cookie)).status).toBe(200);
  await call("POST", `/api/imports/${id}/finish`, {}, u.cookie);
  return id;
}
const count = async (u: TestUser) =>
  (await db().prepare("SELECT COUNT(*) AS n FROM movements WHERE user_id = ?").bind(u.id).first<{ n: number }>())!.n;
const listed = async (u: TestUser, id: number) =>
  (await json(call("GET", "/api/imports", undefined, u.cookie))).items.find((x: any) => x.id === id);
const undo = (u: TestUser, id: number) => json(call("POST", `/api/imports/${id}/undo`, {}, u.cookie));

/** The Worker's env with a D1 whose next big batch commits and then reports a failure (a lost D1 answer). */
function lossyEnv() {
  const real = env.DB;
  let armed = true;
  const DB = new Proxy(real, {
    get(t, k) {
      if (k === "batch") {
        return async (s: D1PreparedStatement[]) => {
          const out = await t.batch(s);
          if (armed && s.length >= 4) {
            armed = false;
            throw new Error("D1_ERROR: Network connection lost.");
          }
          return out;
        };
      }
      const v = (t as any)[k];
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
  return { ...env, DB };
}

describe("a part and its claim are one transaction", () => {
  it("a part that was saved but whose answer was lost is never saved twice on the retry", async () => {
    const u = await makeUser("segw2a");
    const id = await start(u);
    const part = { part: 0, rows: ROWS };
    const headers = { cookie: u.cookie, "content-type": "application/json" };
    const first = await app.request(`${BASE}/api/imports/${id}/rows`, { method: "POST", headers, body: JSON.stringify(part) }, lossyEnv());
    // The rows are in, so the part counts as saved (the old code took the part back and the retry added them again).
    expect(await count(u)).toBe(2);
    expect(first.status).toBe(200);
    const again = await json(call("POST", `/api/imports/${id}/rows`, part, u.cookie));
    expect(again.duplicate_part).toBe(true);
    await call("POST", `/api/imports/${id}/finish`, {}, u.cookie);
    expect(await count(u)).toBe(2);
    expect(await listed(u, id)).toMatchObject({ added: 2, already: 0, status: "done" });
  });

  it("the same part sent twice at once is saved once", async () => {
    const u = await makeUser("segw2b");
    const id = await start(u);
    const part = { part: 0, rows: ROWS };
    const res = await Promise.all([call("POST", `/api/imports/${id}/rows`, part, u.cookie), call("POST", `/api/imports/${id}/rows`, part, u.cookie)]);
    for (const r of res) expect([200, 409]).toContain(r.status);
    expect(await count(u)).toBe(2);
    const parts = await db().prepare("SELECT parts FROM imports WHERE id = ?").bind(id).first<{ parts: number }>();
    expect(parts!.parts).toBe(1);
  });

  it("a part that lands after the import was undone writes nothing", async () => {
    const u = await makeUser("segw2c");
    const id = await start(u);
    const imp = await db().prepare("SELECT * FROM imports WHERE id = ?").bind(id).first<any>();
    await undo(u, id); // the route read the import as open, then the undo won the race
    await expect(saveChunk(db(), u.id, imp, ROWS, 0)).rejects.toThrow();
    expect(await count(u)).toBe(0);
    const rows = await db().prepare("SELECT COUNT(*) AS n FROM import_rows WHERE import_id = ?").bind(id).first<{ n: number }>();
    expect(rows!.n).toBe(0);
    expect((await call("POST", `/api/imports/${id}/rows`, { part: 0, rows: ROWS }, u.cookie)).status).toBe(409);
  });
});

async function typedRow(u: TestUser, fecha: string, cents: number, extra: { nota?: string; tags?: string; cur?: [string, number, number] } = {}) {
  const r = await db().prepare(
    `INSERT INTO movements (user_id, fecha, amount_cents, tipo, comercio, merchant_key, account_id, category_id, tags, nota, origen, estado,
       dedupe_key, orig_currency, orig_cents, fx_micros, created_at, updated_at)
     VALUES (?, ?, ?, 'gasto', 'Typed by me', 'typed by me', ?, ?, ?, ?, 'manual', 'ok', ?, ?, ?, ?, 1, 1) RETURNING id`,
  ).bind(u.id, fecha, cents, u.accountId, u.cats["Restaurantes"], extra.tags ?? "[]", extra.nota ?? "",
    `manual:seg:${Math.random()}`, ...(extra.cur ?? [null, null, null])).first<{ id: number }>();
  return r!.id;
}
const rule = async (u: TestUser, key: string) =>
  (await db().prepare("SELECT category_id FROM merchant_rules WHERE user_id = ? AND merchant_key = ?").bind(u.id, key).first<{ category_id: number }>())?.category_id ?? null;

describe("a merge inside the part", () => {
  it("carries everything the old merge carried, and undo brings the typed row back whole", async () => {
    const u = await makeUser("segw2d");
    const t = await typedRow(u, "2026-10-05", 1234, { nota: "cena", tags: '["viaje","viaje","x"]', cur: ["EUR", 1100, 891410] });
    const typedBefore = await db().prepare("SELECT * FROM movements WHERE id = ?").bind(t).first<any>();
    const person = await json(call("POST", "/api/people", { name: "Ana" }, u.cookie));
    const pid = person.id ?? person.person?.id;
    expect((await call("POST", `/api/people/${pid}/share`, { movement_id: t, kind: "shared", cents: 600 }, u.cookie)).status).toBe(201);
    const id = await imp(u, [ROWS[0]]);

    const bank = await db().prepare("SELECT * FROM movements WHERE user_id = ? AND origen <> 'manual'").bind(u.id).first<any>();
    expect(bank).toMatchObject({ category_id: u.cats["Restaurantes"], nota: "cena", estado: "ok", orig_currency: "EUR", orig_cents: 1100, fx_micros: 891410, fee_cents: null });
    expect(JSON.parse(bank.tags)).toEqual(["viaje", "x"]);
    expect(await db().prepare("SELECT id FROM movements WHERE id = ?").bind(t).first()).toBeNull();
    const pe = await db().prepare("SELECT movement_id FROM person_entries WHERE user_id = ?").bind(u.id).first<{ movement_id: number }>();
    expect(pe!.movement_id).toBe(bank.id);
    expect(await rule(u, bank.merchant_key)).toBe(u.cats["Restaurantes"]);
    expect(await listed(u, id)).toMatchObject({ added: 0, merged: 1 });

    expect(await undo(u, id)).toMatchObject({ removed: 1, restored: 1 });
    const back = await db().prepare("SELECT * FROM movements WHERE id = ?").bind(t).first<any>();
    expect(back).toEqual(typedBefore);
    const pe2 = await db().prepare("SELECT movement_id FROM person_entries WHERE user_id = ?").bind(u.id).first<{ movement_id: number }>();
    expect(pe2!.movement_id).toBe(t);
  });

  it("a key taken by a row outside the window: nothing merges, the typed row stays, and no shop rule is learned", async () => {
    const u = await makeUser("segw2e");
    const t = await typedRow(u, "2026-10-05", 1234);
    // The same statement row saved before and then moved far away in time: it still holds its key.
    const key = `imp:${u.accountId}:2026-10-05:gasto:1234:1`;
    await db().prepare(
      `INSERT INTO movements (user_id, fecha, amount_cents, tipo, comercio, merchant_key, account_id, origen, estado, dedupe_key, created_at, updated_at)
       VALUES (?, '2026-08-01', 1234, 'gasto', 'SEG Shop A', 'seg shop a', ?, 'estado de cuenta', 'ok', ?, 1, 1)`,
    ).bind(u.id, u.accountId, key).run();
    const person = await json(call("POST", "/api/people", { name: "Leo" }, u.cookie));
    const pid = person.id ?? person.person?.id;
    await call("POST", `/api/people/${pid}/share`, { movement_id: t, kind: "shared", cents: 600 }, u.cookie);
    const id = await imp(u, [ROWS[0]]);
    expect(await db().prepare("SELECT id FROM movements WHERE id = ?").bind(t).first()).not.toBeNull();
    const pe = await db().prepare("SELECT movement_id FROM person_entries WHERE user_id = ?").bind(u.id).first<{ movement_id: number }>();
    expect(pe!.movement_id).toBe(t);
    expect(await rule(u, "seg shop a")).toBeNull();
    expect(await count(u)).toBe(2);
    expect(await listed(u, id)).toMatchObject({ added: 0, merged: 0, already: 1 });
    expect(await undo(u, id)).toMatchObject({ removed: 0 });
    expect(await count(u)).toBe(2);
  });
});

describe("undo hand-over", () => {
  it("passes a row down a chain of newer imports and keeps their counts true", async () => {
    const u = await makeUser("segw2f");
    const a = await imp(u);
    const b = await imp(u);
    const c = await imp(u);
    expect(await undo(u, a)).toMatchObject({ removed: 0, kept: 2 });
    // The newest one owns the rows now, and its line in the history says so.
    expect(await listed(u, c)).toMatchObject({ added: 2, already: 0 });
    expect(await listed(u, b)).toMatchObject({ added: 0, already: 2 });
    expect(await undo(u, c)).toMatchObject({ removed: 0, kept: 2 });
    expect(await listed(u, b)).toMatchObject({ added: 2, already: 0 });
    expect(await undo(u, b)).toMatchObject({ removed: 2, kept: 0 });
    expect(await count(u)).toBe(0);
  });

  it("an import undone first is never an heir, and a merged row's typed copy travels with the hand-over", async () => {
    const u = await makeUser("segw2g");
    const t = await typedRow(u, "2026-10-05", 1234, { nota: "mine" });
    const a = await imp(u, [ROWS[0]]);
    const b = await imp(u, [ROWS[0]]);
    const c = await imp(u, [ROWS[0]]);
    await undo(u, c); // c only counted it: nothing removed, and c is out of the chain
    expect(await undo(u, a)).toMatchObject({ removed: 0, kept: 1 });
    expect(await listed(u, b)).toMatchObject({ merged: 1, already: 0 });
    expect(await undo(u, b)).toMatchObject({ removed: 1, restored: 1 });
    const back = await db().prepare("SELECT nota, origen FROM movements WHERE id = ?").bind(t).first<any>();
    expect(back).toEqual({ nota: "mine", origen: "manual" });
    expect(await count(u)).toBe(1);
  });

  it("another user's import of the same file is never an heir, and he cannot undo hers", async () => {
    const a = await makeUser("segw2h");
    const b = await makeUser("segw2i");
    const ia = await imp(a);
    const ib = await imp(b);
    expect((await call("POST", `/api/imports/${ia}/undo`, {}, b.cookie)).status).toBe(404);
    expect(await undo(a, ia)).toMatchObject({ removed: 2, kept: 0 });
    expect(await count(a)).toBe(0);
    expect(await count(b)).toBe(2);
    expect(await listed(b, ib)).toMatchObject({ added: 2, status: "done" });
  });
});
