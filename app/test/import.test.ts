// Statement upload API: preview, chunked save, re-import, undo, limits, users kept apart, and the
// "Primeros pasos" savings and averages. Made-up rows only.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { ingestBankMovement } from "../src/lib/merge.ts";
import { call, json, makeUser, type TestUser } from "./helpers.ts";

type Row = { fecha: string; comercio?: string; cents: number; dir: "out" | "in"; tipo?: "interno" | "ingreso" | null };
const PERIOD = { period_start: "2026-10-01", period_end: "2026-10-31" };

async function emailRow(u: TestUser, fecha: string, cents: number, comercio = "TIENDA DEMO") {
  const r = await ingestBankMovement(env.DB, u.id, {
    dedupe_key: `bac:${fecha}:${cents}:${Math.random()}`, fecha, hora: "12:00", amount_cents: cents, tipo: "gasto",
    comercio, account_id: u.accountId, origen: "correo BAC", raw: "made-up email",
  });
  return (r as { id: number }).id;
}

async function typedRow(u: TestUser, fecha: string, cents: number, categoryId: number | null = null) {
  const now = Date.now();
  const r = await env.DB.prepare(
    `INSERT INTO movements (user_id, fecha, amount_cents, tipo, comercio, merchant_key, account_id, category_id, origen, estado,
       dedupe_key, created_at, updated_at) VALUES (?, ?, ?, 'gasto', 'typed', 'typed', ?, ?, 'manual', ?, ?, ?, ?) RETURNING id`,
  ).bind(u.id, fecha, cents, u.accountId, categoryId, categoryId ? "ok" : "revisar", `manual:${Math.random()}`, now, now).first<{ id: number }>();
  return r!.id;
}

const count = async (u: TestUser) =>
  (await env.DB.prepare("SELECT COUNT(*) AS n FROM movements WHERE user_id = ?").bind(u.id).first<{ n: number }>())!.n;

async function startImport(u: TestUser, extra: Record<string, unknown> = {}) {
  const r = await call("POST", "/api/imports", { account_id: u.accountId, source: "bac_tc", balanced: true, ...PERIOD, ...extra }, u.cookie);
  expect(r.status).toBe(201);
  return (await json<{ id: number }>(r)).id;
}

async function importAll(u: TestUser, rows: Row[]) {
  const id = await startImport(u);
  const r = await call("POST", `/api/imports/${id}/rows`, { part: 0, rows }, u.cookie);
  expect(r.status).toBe(200);
  const done = await json(call("POST", `/api/imports/${id}/finish`, {}, u.cookie));
  return { id, totals: done.totals as { added: number; already: number; merged: number; review: number } };
}

const statement = (): Row[] => [
  { fecha: "2026-10-05", comercio: "TIENDA DEMO", cents: 1234, dir: "out" }, // the BAC email has it
  { fecha: "2026-10-06", comercio: "CAFE DEMO", cents: 250, dir: "out" }, // two equal purchases on one day are real
  { fecha: "2026-10-06", comercio: "CAFE DEMO", cents: 250, dir: "out" },
  { fecha: "2026-10-07", comercio: "SU PAGO EN LINEA", cents: 5000, dir: "in", tipo: "interno" },
  { fecha: "2026-10-08", comercio: "SUPER DEMO", cents: 999, dir: "out" }, // typed by hand on the 9th
  { fecha: "2026-10-10", comercio: "RESTAURANTE DEMO", cents: 1500, dir: "out" },
];

describe("import: preview, save, re-import", () => {
  it("previews without saving, then saves, and a second import of the same file adds nothing", async () => {
    const u = await makeUser("imp");
    await emailRow(u, "2026-10-04", 1234);
    const typed = await typedRow(u, "2026-10-09", 999, u.cats["Café y snacks"]);
    const before = await count(u);

    const p = await call("POST", "/api/imports/preview", { account_id: u.accountId, source: "bac_tc", ...PERIOD, rows: statement() }, u.cookie);
    expect(p.status).toBe(200);
    expect(await json(p)).toEqual({ added: 4, already: 1, merged: 1, review: 1 });
    expect(await count(u)).toBe(before);

    const first = await importAll(u, statement());
    expect(first.totals).toEqual({ added: 4, already: 1, merged: 1, review: 1 });
    expect(await count(u)).toBe(before + 4); // 5 new bank rows, minus the typed row merged into one of them
    expect(await env.DB.prepare("SELECT id FROM movements WHERE id = ?").bind(typed).first()).toBeNull();
    const merged = await env.DB.prepare("SELECT category_id, origen FROM movements WHERE user_id = ? AND amount_cents = 999").bind(u.id).first();
    expect(merged).toEqual({ category_id: u.cats["Café y snacks"], origen: "estado de cuenta" }); // the typed category wins

    const second = await importAll(u, statement());
    expect(second.totals).toEqual({ added: 0, already: 6, merged: 0, review: 0 });
    expect(await count(u)).toBe(before + 4);

    const list = await json(call("GET", "/api/imports", undefined, u.cookie));
    expect(list.items).toHaveLength(2);
    expect(list.coverage).toEqual([{ account_id: u.accountId, months: ["2026-10"] }]);
  });

  it("sorts by the user's own shop memory first, then the starter rules, then Revisar", async () => {
    const u = await makeUser("imp");
    await env.DB.prepare("INSERT INTO merchant_rules (user_id, merchant_key, category_id, updated_at) VALUES (?, 'cafe demo', ?, 0)")
      .bind(u.id, u.cats["Restaurantes"]).run();
    const { id } = await importAll(u, statement());
    const rows = await env.DB.prepare("SELECT comercio, category_id, estado, tipo FROM movements WHERE user_id = ? ORDER BY fecha, id").bind(u.id).all();
    const by = (c: string) => rows.results.find((r) => r.comercio === c)!;
    expect(by("CAFE DEMO")).toMatchObject({ category_id: u.cats["Restaurantes"], estado: "ok" }); // memory beats the starter rule
    expect(by("SUPER DEMO")).toMatchObject({ category_id: u.cats["Supermercado"], estado: "ok" }); // starter rule
    // starter rule says "Restaurantes y comida rápida", which this user does not have: Revisar
    expect(by("RESTAURANTE DEMO")).toMatchObject({ category_id: null, estado: "revisar" });
    expect(by("SU PAGO EN LINEA")).toMatchObject({ tipo: "interno", estado: "ok", category_id: null });
    const review = await json(call("GET", `/api/imports/${id}/review`, undefined, u.cookie));
    // the rows nothing knew, biggest first
    expect(review.items.map((m: { comercio: string }) => m.comercio)).toEqual(["RESTAURANTE DEMO", "TIENDA DEMO"]);
  });

  it("a card payment is internal: it never counts as spending", async () => {
    const u = await makeUser("imp");
    await importAll(u, [
      { fecha: "2026-10-03", comercio: "SUPER DEMO", cents: 2000, dir: "out" },
      { fecha: "2026-10-07", comercio: "SU PAGO EN LINEA", cents: 90000, dir: "in", tipo: "interno" },
      { fecha: "2026-10-08", comercio: "PAGO DEMO", cents: 7000, dir: "out", tipo: "interno" },
    ]);
    const s = await json(call("GET", "/api/summary?month=2026-10", undefined, u.cookie));
    expect(s.spent_cents).toBe(2000);
    expect(s.income_cents).toBe(0);
  });

  it("two typed rows that could both be the purchase go to Revisar as merge suggestions", async () => {
    const u = await makeUser("imp");
    await typedRow(u, "2026-10-05", 700);
    await typedRow(u, "2026-10-06", 700);
    const { totals } = await importAll(u, [{ fecha: "2026-10-05", comercio: "TIENDA DEMO", cents: 700, dir: "out" }]);
    expect(totals).toMatchObject({ added: 1, merged: 0, review: 1 });
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM merge_suggestions WHERE user_id = ?").bind(u.id).first<{ n: number }>();
    expect(n!.n).toBe(2);
  });
});

describe("import: checks on every row", () => {
  it("refuses dates outside the statement period (7 days either side) and in the future", async () => {
    const u = await makeUser("imp");
    const id = await startImport(u);
    const send = (rows: Row[], part = 0) => call("POST", `/api/imports/${id}/rows`, { part, rows }, u.cookie);
    expect((await send([{ fecha: "2026-11-08", cents: 100, dir: "out" }])).status).toBe(400);
    expect((await send([{ fecha: "2026-09-23", cents: 100, dir: "out" }])).status).toBe(400);
    expect((await send([{ fecha: "2026-11-07", cents: 100, dir: "out" }, { fecha: "2026-09-24", cents: 100, dir: "out" }])).status).toBe(200);
    const future = await call("POST", "/api/imports", { account_id: u.accountId, source: "csv", balanced: false, period_start: "2026-10-01", period_end: "2099-01-01" }, u.cookie);
    expect(future.status).toBe(400);
    const p = await call("POST", "/api/imports/preview", { account_id: u.accountId, source: "bac_tc", ...PERIOD, rows: [{ fecha: "2026-12-01", cents: 1, dir: "out" }] }, u.cookie);
    expect(p.status).toBe(400);
  });

  it("refuses bad amounts, long text and tipos the phone may not set, and strips invisible characters", async () => {
    const u = await makeUser("imp");
    const id = await startImport(u);
    const send = (row: Record<string, unknown>) => call("POST", `/api/imports/${id}/rows`, { part: 0, rows: [row] }, u.cookie);
    const base = { fecha: "2026-10-05", dir: "out" };
    for (const bad of [{ cents: 0 }, { cents: -5 }, { cents: 1.5 }, { cents: 10_000_001 }, { cents: 100, comercio: "x".repeat(121) },
      { cents: 100, tipo: "gasto" }, { cents: 100, tipo: "rechazado" }, { cents: 100, dir: "sideways" }]) {
      expect((await send({ ...base, ...bad })).status).toBe(400);
    }
    expect((await send({ ...base, cents: 100, comercio: "TIENDA‮ DEMO​" })).status).toBe(200);
    const m = await env.DB.prepare("SELECT comercio FROM movements WHERE user_id = ?").bind(u.id).first<{ comercio: string }>();
    expect(m!.comercio).toBe("TIENDA DEMO");
  });

  it("takes at most 500 rows per request, 2,000 per import and 5,000 per user per day", async () => {
    const u = await makeUser("imp");
    const id = await startImport(u);
    const rows = (n: number, day = 5): Row[] => Array.from({ length: n }, (_, i) => ({ fecha: `2026-10-${String(day).padStart(2, "0")}`, cents: 100 + i, dir: "out" }));
    expect((await call("POST", `/api/imports/${id}/rows`, { part: 0, rows: rows(501) }, u.cookie)).status).toBe(400);
    expect((await call("POST", `/api/imports/${id}/rows`, { part: 0, rows: rows(500) }, u.cookie)).status).toBe(200);
    // pretend 1,600 more rows of this import were saved earlier
    await env.DB.prepare(
      `WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 1600)
       INSERT INTO import_rows (import_id, user_id, movement_id, kind, base, created_at) SELECT ?, ?, NULL, 'already', 'x', ? FROM n`,
    ).bind(id, u.id, Date.now()).run();
    expect((await call("POST", `/api/imports/${id}/rows`, { part: 1, rows: rows(1, 6) }, u.cookie)).status).toBe(413);
    // a new import on the same day: 2,100 rows so far, pretend 2,850 more from other imports
    const other = await startImport(u);
    await env.DB.prepare(
      `WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 2850)
       INSERT INTO import_rows (import_id, user_id, movement_id, kind, base, created_at) SELECT ?, ?, NULL, 'already', 'y', ? FROM n`,
    ).bind(id, u.id, Date.now()).run();
    expect((await call("POST", `/api/imports/${other}/rows`, { part: 0, rows: rows(51, 7) }, u.cookie)).status).toBe(429);
    expect((await call("POST", `/api/imports/${other}/rows`, { part: 0, rows: rows(50, 7) }, u.cookie)).status).toBe(200);
  });

  it("a chunk sent twice is saved once, and chunks come in order", async () => {
    const u = await makeUser("imp");
    const id = await startImport(u);
    const rows: Row[] = [{ fecha: "2026-10-05", cents: 100, dir: "out" }];
    expect((await call("POST", `/api/imports/${id}/rows`, { part: 0, rows }, u.cookie)).status).toBe(200);
    const again = await json(call("POST", `/api/imports/${id}/rows`, { part: 0, rows }, u.cookie));
    expect(again.duplicate_part).toBe(true);
    expect(await count(u)).toBe(1);
    expect((await call("POST", `/api/imports/${id}/rows`, { part: 2, rows }, u.cookie)).status).toBe(409);
    await call("POST", `/api/imports/${id}/finish`, {}, u.cookie);
    expect((await call("POST", `/api/imports/${id}/rows`, { part: 1, rows }, u.cookie)).status).toBe(409);
  });
});

describe("import: undo", () => {
  it("removes what the import added, brings back the typed row it merged, and leaves the rest alone", async () => {
    const u = await makeUser("imp");
    const email = await emailRow(u, "2026-10-04", 1234);
    const typed = await typedRow(u, "2026-10-09", 999, u.cats["Supermercado"]);
    const before = await env.DB.prepare("SELECT * FROM movements WHERE user_id = ? ORDER BY id").bind(u.id).all();
    const { id } = await importAll(u, statement());
    expect(await count(u)).toBe(before.results.length + 4);

    const r = await json(call("POST", `/api/imports/${id}/undo`, {}, u.cookie));
    expect(r).toEqual({ removed: 5, restored: 1, kept: 0 });
    const after = await env.DB.prepare("SELECT * FROM movements WHERE user_id = ? ORDER BY id").bind(u.id).all();
    expect(after.results).toEqual(before.results);
    expect(after.results.map((m) => m.id)).toEqual([email, typed]);
    expect((await json(call("POST", `/api/imports/${id}/undo`, {}, u.cookie))).already_undone).toBe(true);
    const list = await json(call("GET", "/api/imports", undefined, u.cookie));
    expect(list.items[0].status).toBe("undone");
    expect(list.coverage).toEqual([]);

    // and the same file can come in again
    const again = await importAll(u, statement());
    expect(again.totals).toMatchObject({ added: 4, merged: 1 });
  });
});

describe("import: users kept apart", () => {
  it("every import route answers 404 or 400 for another user's import, account or data", async () => {
    const a = await makeUser("impa");
    const b = await makeUser("impb");
    const { id } = await importAll(a, statement());
    const open = await startImport(a);
    for (const [method, path] of [
      ["POST", `/api/imports/${open}/rows`], ["POST", `/api/imports/${id}/finish`], ["POST", `/api/imports/${id}/undo`], ["GET", `/api/imports/${id}/review`],
    ] as const) {
      const body = method === "GET" ? undefined : { part: 0, rows: [{ fecha: "2026-10-05", cents: 1, dir: "out" }] };
      const r = await call(method, path, body, b.cookie);
      expect([path, r.status]).toEqual([path, 404]);
    }
    expect((await call("POST", "/api/imports/preview", { account_id: a.accountId, source: "bac_tc", ...PERIOD, rows: statement() }, b.cookie)).status).toBe(400);
    expect((await call("POST", "/api/imports", { account_id: a.accountId, source: "csv", balanced: false, ...PERIOD }, b.cookie)).status).toBe(400);
    const sig = "0123456789abcdef0123456789abcdef";
    const map = { fecha: 0, comercio: 1, monto: 2, cargo: null, abono: null, saldo: null, order: "dmy", sign: "out_negative" };
    expect((await call("PUT", `/api/imports/csv-maps/${sig}`, { account_id: a.accountId, map }, b.cookie)).status).toBe(400);
    expect((await call("PUT", `/api/imports/csv-maps/${sig}`, { account_id: a.accountId, map }, a.cookie)).status).toBe(200);
    expect(await json(call("GET", `/api/imports/csv-maps/${sig}`, undefined, b.cookie))).toEqual({ account_id: null, map: null });
    expect((await json(call("GET", `/api/imports/csv-maps/${sig}`, undefined, a.cookie))).account_id).toBe(a.accountId);
    expect((await call("GET", "/api/imports/csv-maps/not-a-sig", undefined, a.cookie)).status).toBe(404);
    expect((await json(call("GET", "/api/imports", undefined, b.cookie))).items).toEqual([]);
    expect((await call("POST", "/api/imports/recurring", { merchant_key: "cafe demo", keep: false }, b.cookie)).status).toBe(404);
    await call("PUT", "/api/pasos/savings", { amount_cents: 10000 }, a.cookie);
    expect((await json(call("GET", "/api/pasos", undefined, b.cookie))).savings_cents).toBeNull();
    // b's undo did nothing to a's rows
    expect(await count(a)).toBe(6);
    expect(await count(b)).toBe(0);
  });

  it("the database refuses rows that point at another user's rows, and rows never change owner", async () => {
    const a = await makeUser("impa");
    const b = await makeUser("impb");
    const { id } = await importAll(a, statement());
    const now = Date.now();
    await expect(env.DB.prepare(
      "INSERT INTO imports (user_id, account_id, source, period_start, period_end, created_at, updated_at) VALUES (?, ?, 'csv', '2026-10-01', '2026-10-31', ?, ?)",
    ).bind(b.id, a.accountId, now, now).run()).rejects.toThrow(/cross_user/);
    await expect(env.DB.prepare("INSERT INTO import_rows (import_id, user_id, kind, base, created_at) VALUES (?, ?, 'already', 'x', ?)")
      .bind(id, b.id, now).run()).rejects.toThrow(/cross_user/);
    const am = await env.DB.prepare("SELECT id FROM movements WHERE user_id = ? LIMIT 1").bind(a.id).first<{ id: number }>();
    const bi = await startImport(b);
    await expect(env.DB.prepare("INSERT INTO import_rows (import_id, user_id, movement_id, kind, base, created_at) VALUES (?, ?, ?, 'already', 'x', ?)")
      .bind(bi, b.id, am!.id, now).run()).rejects.toThrow(/cross_user/);
    await expect(env.DB.prepare("INSERT INTO import_csv_maps (user_id, header_sig, account_id, map, updated_at) VALUES (?, 'x', ?, '{}', ?)")
      .bind(b.id, a.accountId, now).run()).rejects.toThrow(/cross_user/);
    for (const t of ["imports", "import_rows"]) {
      await expect(env.DB.prepare(`UPDATE ${t} SET user_id = ? WHERE user_id = ?`).bind(b.id, a.id).run()).rejects.toThrow(/user_id_fixed/);
    }
    await call("PUT", "/api/pasos/savings", { amount_cents: 500 }, a.cookie);
    await expect(env.DB.prepare("UPDATE savings_plan SET user_id = ? WHERE user_id = ?").bind(b.id, a.id).run()).rejects.toThrow(/user_id_fixed/);
  });
});

describe("Primeros pasos", () => {
  it("finds fixed payments and remembers keep or remove", async () => {
    const u = await makeUser("pasos");
    const today = new Date(Date.now() - 6 * 3600_000);
    const ago = (d: number) => new Date(today.getTime() - d * 86400_000).toISOString().slice(0, 10);
    for (const d of [65, 35, 5]) await emailRow(u, ago(d), 1099, "STREAMING DEMO");
    const r = await json(call("GET", "/api/imports/recurring", undefined, u.cookie));
    expect(r.items.map((x: { merchant_key: string; every_days: number; keep: unknown }) => [x.merchant_key, x.every_days, x.keep])).toEqual([["streaming demo", 30, null]]);
    expect((await call("POST", "/api/imports/recurring", { merchant_key: "streaming demo", keep: false }, u.cookie)).status).toBe(200);
    expect((await json(call("GET", "/api/imports/recurring", undefined, u.cookie))).items[0].keep).toBe(false);
    expect((await call("POST", "/api/imports/recurring", { merchant_key: "not a fixed payment", keep: true }, u.cookie)).status).toBe(404);
  });

  it("averages each group over full months with the summary's spending rule, and shows income only when there is some", async () => {
    const u = await makeUser("pasos");
    const now = Date.now();
    const add = (fecha: string, cents: number, tipo: string, cat: number | null) =>
      env.DB.prepare(
        `INSERT INTO movements (user_id, fecha, amount_cents, tipo, comercio, merchant_key, account_id, category_id, origen, estado, dedupe_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'x', 'x', ?, ?, 'estado de cuenta', 'ok', ?, ?, ?)`,
      ).bind(u.id, fecha, cents, tipo, u.accountId, cat, `t:${Math.random()}`, now, now).run();
    const ym = (back: number) => {
      const d = new Date(Date.now() - 6 * 3600_000);
      d.setUTCDate(1);
      d.setUTCMonth(d.getUTCMonth() - back);
      return d.toISOString().slice(0, 7);
    };
    await add(`${ym(2)}-01`, 30000, "gasto", u.cats["Supermercado"]);
    await add(`${ym(1)}-10`, 20000, "gasto", u.cats["Café y snacks"]);
    await add(`${ym(1)}-11`, 5000, "abono", u.cats["Café y snacks"]); // a refund subtracts
    await add(`${ym(1)}-12`, 99900, "interno", null); // a card payment is not spending
    await add(`${ym(0)}-01`, 77700, "gasto", u.cats["Supermercado"]); // this month is not over: left out
    let p = await json(call("GET", "/api/pasos", undefined, u.cookie));
    expect(p.months).toEqual([ym(2), ym(1)]);
    expect(p.groups[0]).toMatchObject({ name: "Comida", avg_cents: 22500, limit_cents: 50000 });
    expect(p.income_avg_cents).toBeNull();
    await add(`${ym(1)}-15`, 100000, "ingreso", null);
    p = await json(call("GET", "/api/pasos", undefined, u.cookie));
    expect(p.income_avg_cents).toBe(50000);
    expect(p.limits_sum_cents).toBe(50000);
  });

  it("the savings amount is kept apart and does not change Te quedan", async () => {
    const u = await makeUser("pasos");
    const month = new Date(Date.now() - 6 * 3600_000).toISOString().slice(0, 7);
    const before = await json(call("GET", `/api/summary?month=${month}`, undefined, u.cookie));
    const r = await call("PUT", "/api/pasos/savings", { amount_cents: 15000 }, u.cookie);
    expect(r.status).toBe(200);
    expect((await call("PUT", "/api/pasos/savings", { amount_cents: -1 }, u.cookie)).status).toBe(400);
    const after = await json(call("GET", `/api/summary?month=${month}`, undefined, u.cookie));
    expect(after.limit_cents).toBe(before.limit_cents);
    expect(after.limited_spent_cents).toBe(before.limited_spent_cents);
    expect(after.groups).toEqual(before.groups);
    expect((await json(call("GET", "/api/pasos", undefined, u.cookie))).savings_cents).toBe(15000);
  });
});
