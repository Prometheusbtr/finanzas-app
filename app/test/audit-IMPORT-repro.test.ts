// Audit IMPORT: reproductions on a throwaway D1 (synthetic users and rows only). Each test prints one FACT line.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { call, json, makeUser, type TestUser } from "./helpers.ts";

type Row = { fecha: string; comercio?: string; cents: number; dir: "out" | "in"; tipo?: "interno" | "ingreso" | null };
const db = () => env.DB;

async function imp(u: TestUser, rows: Row[], source = "csv", account = u.accountId) {
  const ds = rows.map((r) => r.fecha).sort();
  const r = await call("POST", "/api/imports", { account_id: account, source, balanced: false, period_start: ds[0], period_end: ds[ds.length - 1] }, u.cookie);
  expect(r.status).toBe(201);
  const { id } = await json<{ id: number }>(r);
  const p = await call("POST", `/api/imports/${id}/rows`, { part: 0, rows }, u.cookie);
  const fin = await json(call("POST", `/api/imports/${id}/finish`, {}, u.cookie));
  return { id, status: p.status, totals: fin.totals as { added: number; already: number; merged: number; review: number } };
}
const movs = async (u: TestUser) =>
  (await db().prepare("SELECT id, fecha, comercio, amount_cents, tipo, origen, estado FROM movements WHERE user_id = ? ORDER BY fecha, id").bind(u.id).all()).results as any[];

async function typed(u: TestUser, fecha: string, cents: number, comercio = "QA-IMPORT Typed") {
  const r = await db().prepare(
    `INSERT INTO movements (user_id, fecha, amount_cents, tipo, comercio, merchant_key, account_id, category_id, origen, estado, dedupe_key, created_at, updated_at)
     VALUES (?, ?, ?, 'gasto', ?, '', ?, ?, 'manual', 'ok', ?, 1, 1) RETURNING id`,
  ).bind(u.id, fecha, cents, comercio, u.accountId, u.cats["Supermercado"], `manual:${Math.random()}`).first<{ id: number }>();
  return r!.id;
}

describe("audit IMPORT", () => {
  it("F01: consecutive statements with the same daily price lose purchases near the boundary", async () => {
    const u = await makeUser("qa-imp-f01");
    // Statement 1 ends Oct 14 with a $2.50 coffee on the 12th, 13th and 14th. Statement 2 starts Oct 15 with three more.
    const s1: Row[] = ["2026-10-12", "2026-10-13", "2026-10-14"].map((fecha) => ({ fecha, comercio: "QA Cafe A", cents: 250, dir: "out" }));
    const s2: Row[] = ["2026-10-15", "2026-10-16", "2026-10-17"].map((fecha) => ({ fecha, comercio: "QA Cafe A", cents: 250, dir: "out" }));
    const a = await imp(u, s1, "bac_tc");
    const b = await imp(u, s2, "bac_tc");
    const rows = await movs(u);
    const fact = { first: a.totals, second: b.totals, ledger_rows: rows.length, expected: 6, dates: rows.map((r) => r.fecha) };
    console.log("FACT f01", JSON.stringify(fact));
    expect(rows.length).toBe(6); // F01 fixed: every coffee of the second statement is new
    expect(b.totals).toMatchObject({ added: 3, already: 0 });
  });

  it("NEW: undoing the first of two imports of the same file deletes every row the second one still counts", async () => {
    const u = await makeUser("qa-imp-undo");
    const rows: Row[] = [
      { fecha: "2026-10-05", comercio: "QA Shop A", cents: 1234, dir: "out" },
      { fecha: "2026-10-06", comercio: "QA Shop B", cents: 500, dir: "out" },
    ];
    const a = await imp(u, rows, "bac_tc");
    const b = await imp(u, rows, "bac_tc"); // the same file again by mistake: all "ya estaban"
    const undo = await json(call("POST", `/api/imports/${a.id}/undo`, {}, u.cookie)); // the user removes "the duplicate"
    const list = await json(call("GET", "/api/imports", undefined, u.cookie));
    const second = list.items.find((x: any) => x.id === b.id);
    const left = await movs(u);
    const fact = { second_totals: b.totals, undo, ledger_after: left.length, second_status: second.status, second_listed_already: second.already };
    console.log("FACT undo_cross", JSON.stringify(fact));
    expect(undo).toMatchObject({ removed: 0, kept: 2 }); // F03 fixed: handed over to the second import
    expect(left.length).toBe(2);
    expect(second.status).toBe("done");
    const undo2 = await json(call("POST", `/api/imports/${b.id}/undo`, {}, u.cookie));
    expect(undo2).toMatchObject({ removed: 2 });
    expect((await movs(u)).length).toBe(0);
  });

  it("F20 (fixed): a late failure saves nothing, and the retry on the same import merges the typed twin", async () => {
    const u = await makeUser("qa-imp-f04");
    const t1 = await typed(u, "2026-10-05", 321);
    const first = { account_id: u.accountId, source: "csv", balanced: false, period_start: "2026-10-01", period_end: "2026-10-30" };
    const a = await json<{ id: number }>(call("POST", "/api/imports", first, u.cookie));
    const part = { part: 0, rows: [{ fecha: "2026-10-05", cents: 321, dir: "out", comercio: "QA Shop F04" }] };
    // A failure on the last write of the part (deleting the typed row after the merge).
    await db().prepare("CREATE TRIGGER qa_imp_fail_del BEFORE DELETE ON movements BEGIN SELECT RAISE(ABORT, 'simulated'); END").run();
    const one = await call("POST", `/api/imports/${a.id}/rows`, part, u.cookie);
    await db().prepare("DROP TRIGGER qa_imp_fail_del").run();
    const mid = await movs(u);
    const midRows = await db().prepare("SELECT COUNT(*) AS n FROM import_rows WHERE user_id = ?").bind(u.id).first<{ n: number }>();
    // importar.js now sends the same part again to the same import.
    const two = await json(call("POST", `/api/imports/${a.id}/rows`, part, u.cookie));
    const fin = await json(call("POST", `/api/imports/${a.id}/finish`, {}, u.cookie));
    const rows = await movs(u);
    const list = await json(call("GET", "/api/imports", undefined, u.cookie));
    console.log("FACT f20_fixed", JSON.stringify({ first: one.status, mid: mid.length, midRows: midRows!.n, retry: two.saved, totals: fin.totals, rows: rows.length }));
    expect(one.status).toBe(500);
    expect(mid.map((r) => r.id)).toEqual([t1]); // nothing of the failed part was written
    expect(midRows!.n).toBe(0);
    expect(two.saved).toMatchObject({ merged: 1 });
    expect(rows.length).toBe(1);
    expect(rows[0].origen).toBe("archivo CSV");
    expect(list.items.filter((x: any) => x.status === "open").length).toBe(0);
    // Undo brings the typed row back.
    const undo = await json(call("POST", `/api/imports/${a.id}/undo`, {}, u.cookie));
    expect(undo).toMatchObject({ removed: 1, restored: 1 });
    expect((await movs(u)).map((r) => r.id)).toEqual([t1]);
  });

  it("review inbox: the exact point where GET /review hits the 100 bound-parameter limit", async () => {
    const out: Record<string, number> = {};
    for (const banks of [33, 34, 100]) {
      const u = await makeUser("qa-imp-rv" + banks);
      for (let i = 0; i < banks; i++) {
        const ids: number[] = [];
        for (const [j, origen] of ["archivo CSV", "manual", "manual"].entries()) {
          const r = await db().prepare("INSERT INTO movements (user_id, fecha, amount_cents, tipo, origen, estado, dedupe_key, created_at, updated_at) VALUES (?, '2026-10-01', ?, 'gasto', ?, ?, ?, 1, 1) RETURNING id")
            .bind(u.id, 1000 + i, origen, j === 0 ? "revisar" : "ok", `qa${banks}-${i}-${j}`).first<{ id: number }>();
          ids.push(r!.id);
        }
        await db().batch(ids.slice(1).map((m) => db().prepare("INSERT INTO merge_suggestions (user_id, bank_id, manual_id, created_at) VALUES (?, ?, ?, 1)").bind(u.id, ids[0], m)));
      }
      const res = await call("GET", "/api/review", undefined, u.cookie);
      out[`${banks}_banks_${banks * 3}_ids`] = res.status;
      if (res.status === 200) expect((await json(res)).suggestions.length).toBe(banks * 2);
    }
    console.log("FACT review_limit", JSON.stringify(out));
    expect(out).toEqual({ "33_banks_99_ids": 200, "34_banks_102_ids": 200, "100_banks_300_ids": 200 }); // F21 fixed
  });

  it("steps: a CSV import never counts as the statements step on the server", async () => {
    const u = await makeUser("qa-imp-steps");
    await imp(u, [{ fecha: "2026-10-05", comercio: "QA Shop C", cents: 700, dir: "out" }], "csv");
    const csv = await json(call("GET", "/api/setup", undefined, u.cookie));
    const u2 = await makeUser("qa-imp-steps2");
    await imp(u2, [{ fecha: "2026-10-05", comercio: "QA Shop C", cents: 700, dir: "out" }], "bac_tc");
    const pdf = await json(call("GET", "/api/setup", undefined, u2.cookie));
    const st = (s: any) => s.steps.find((x: any) => x.id === "statements").state;
    const origen = (await movs(u))[0].origen;
    console.log("FACT steps_csv", JSON.stringify({ csv_origen: origen, csv_state: st(csv), pdf_state: st(pdf) }));
    expect(st(csv)).toBe("done"); // F53 fixed
    expect(st(pdf)).toBe("done");
  });

  it("Revisar: a CSV pay waits as ingreso; the screen's 'No es gasto' turns it into interno and it leaves the income", async () => {
    const u = await makeUser("qa-imp-inc");
    await imp(u, [{ fecha: "2026-10-05", comercio: "QA Employer", cents: 150000, dir: "in" }], "csv");
    const before = await json(call("GET", "/api/summary?month=2026-10", undefined, u.cookie));
    const rv = await json(call("GET", "/api/review", undefined, u.cookie));
    const item = rv.items[0];
    await call("PUT", `/api/movements/${item.id}`, { tipo: "ingreso", estado: "ok" }, u.cookie); // F22: review.js "Es ingreso"
    const after = await json(call("GET", "/api/summary?month=2026-10", undefined, u.cookie));
    const pick = (s: any) => s.income_cents ?? s.income ?? s.ingresos ?? null;
    console.log("FACT csv_income", JSON.stringify({ review_tipo: item.tipo, review_estado: item.estado, income_before: pick(before), income_after: pick(after), keys: Object.keys(after) }));
    expect(item.tipo).toBe("ingreso");
    expect(pick(after)).toBe(150000);
    const left = await json(call("GET", "/api/review", undefined, u.cookie));
    expect(left.items.length).toBe(0);
  });
});

describe("audit IMPORT merge kinds", () => {
  it("a typed transfer (interno) or ignored row is merged into the bank row as spending (gasto)", async () => {
    const out: Record<string, unknown> = {};
    for (const [tipo, withCat] of [["interno", false], ["interno", true], ["ignorado", false]] as const) {
      const u = await makeUser("qa-imp-mk");
      const t = await db().prepare(
        `INSERT INTO movements (user_id, fecha, amount_cents, tipo, comercio, merchant_key, account_id, category_id, origen, estado, dedupe_key, created_at, updated_at)
         VALUES (?, '2026-10-05', 5000, ?, 'QA-IMPORT my transfer', '', ?, ?, 'manual', 'ok', ?, 1, 1) RETURNING id`,
      ).bind(u.id, tipo, u.accountId, withCat ? u.cats["Supermercado"] : null, `manual:${Math.random()}`).first<{ id: number }>();
      const r = await imp(u, [{ fecha: "2026-10-05", comercio: "QA BANK TRANSFER OUT", cents: 5000, dir: "out" }], "csv");
      const rows = await movs(u);
      const sum = await json(call("GET", "/api/summary?month=2026-10", undefined, u.cookie));
      out[`${tipo}${withCat ? "+category" : ""}`] = { totals: r.totals, typed_kept: rows.some((x) => x.id === t!.id), rows: rows.map((x) => [x.tipo, x.estado]), spent_cents: sum.spent_cents };
    }
    console.log("FACT merge_kinds", JSON.stringify(out));
    for (const k of ["interno", "interno+category", "ignorado"]) {
      const o = out[k] as any; // F10 fixed: the typed row is the record
      expect(o.typed_kept).toBe(true);
      expect(o.rows.length).toBe(1);
      expect(o.spent_cents).toBe(0);
      expect(o.totals).toMatchObject({ added: 0, already: 1, merged: 0 });
    }
  });
});

describe("audit IMPORT wallet credit", () => {
  it("an UglyCash money-in row the reader cannot name is saved as a refund and lowers spending", async () => {
    const u = await makeUser("qa-imp-wallet");
    await imp(u, [
      { fecha: "2026-10-05", comercio: "QA Shop Beta", cents: 5000, dir: "out" },
      { fecha: "2026-10-06", comercio: "QA Incoming", cents: 2000, dir: "in" }, // parse.js uglyTipo returns null for an unknown "+" line
    ], "uglycash");
    const rows = await movs(u);
    const sum = await json(call("GET", "/api/summary?month=2026-10", undefined, u.cookie));
    console.log("FACT wallet_credit", JSON.stringify({ rows: rows.map((r) => [r.comercio, r.tipo, r.estado]), spent_cents: sum.spent_cents, income_cents: sum.income_cents, uncategorized_cents: sum.uncategorized_cents }));
    const inc = rows.find((r) => r.comercio === "QA Incoming"); // F09 fixed: income waiting in Revisar
    expect([inc.tipo, inc.estado]).toEqual(["ingreso", "revisar"]);
    expect(sum.spent_cents).toBe(5000);
    expect(sum.income_cents).toBe(2000);
  });
});
