// Statement readers, CSV, fixed payments and the "Primeros pasos" math, on made-up data only.
import { describe, expect, it } from "vitest";
import { amountCents, dateOf, guessMap, headerText, parseCsv, readCsv } from "../public/import/csv.js";
import { detect, itemsToLines, maskDigits, readStatement, type Page } from "../public/import/parse.js";
import { fullMonths, limitChoices, roundTo5 } from "../src/lib/plan.ts";
import { findRecurring, monthlyCents } from "../src/lib/recurring.ts";
import { starterCategory } from "../src/lib/rules.ts";
import { CHUNK_BYTES, CHUNK_ROWS, apiRows, chunkRows, monthsOf } from "../public/import/upload.js";

/** A page from lines of [x, text] cells; every character is 5 points wide, lines 12 points apart. */
function page(lines: [number, string][][], top = 700): Page {
  const items = lines.flatMap((cells, i) => cells.map(([x, s]) => ({ s, x, y: top - i * 12, w: s.length * 5, h: 8 })));
  return { items };
}

const agricola = (rows: [string, string, string, string, string][], total: [string, string]) =>
  page([
    [[40, "BANCO DEMO"], [300, "ESTADO DE CUENTA"]],
    [[40, "TARJETA"], [120, "4000-XX99-0001"]],
    [[40, "FECHA DE CORTE"], [130, "09/11/2026"]],
    ...rows.map(([auth, d, concept, charge, credit]) => [[100, auth], [150, d], [220, concept], [420, charge], [480, credit]] as [number, string][]),
    [[220, "TOTAL TRANSACCIONES T.CRED"], [420, total[0]], [480, total[1]]],
  ]);

describe("Agrícola credit card reader", () => {
  const rows: [string, string, string, string, string][] = [
    ["000111", "31/10/2026", "TIENDA DEMO UNO", "12.50", "0.00"],
    ["000112", "01/11/2026", "SUPER DEMO", "1,020.05", "0.00"],
    ["000113", "02/11/2026", "DEVOLUCION DEMO", "0.00", "2.55"],
  ];
  it("reads the rows, the cut date and the card, and checks them against the statement total", () => {
    const st = readStatement([agricola(rows, ["1,032.55", "2.55"])])!;
    expect(st.kind).toBe("agricola_tc");
    expect(st.cut).toBe("2026-11-09");
    expect(st.card).toBe("0001");
    expect(st.rows.map((r) => [r.fecha, r.cents])).toEqual([["2026-10-31", 1250], ["2026-11-01", 102005], ["2026-11-02", -255]]);
    expect(st.check).toMatchObject({ ok: true, expected: 103000, got: 103000 });
    expect(st.period).toEqual({ start: "2026-10-31", end: "2026-11-09" });
  });
  it("says exactly how far off it is when the rows do not add up", () => {
    const st = readStatement([agricola(rows.slice(0, 2), ["1,032.55", "2.55"])])!;
    expect(st.check).toMatchObject({ ok: false, expected: 103000, got: 103255, diff: 255 });
  });
});

const ugly = (summary: { start: string; credits: string; debits: string; rewards: string; end: string }, rows: [string, string, string][]) => [
  page([
    [[40, "UglyCash"], [300, "Monthly statement"]],
    [[40, "Balance on 10/1"], [200, "$" + summary.start]],
    [[40, "Credits"], [200, "+$" + summary.credits]],
    [[40, "Debits"], [200, "-$" + summary.debits]],
    [[40, "Rewards earned"], [200, "+$" + summary.rewards]],
    [[40, "Balance on 10/31"], [200, "$" + summary.end]],
  ]),
  page(rows.map(([d, desc, amt]) => [[40, d], [120, desc], [450, amt]] as [number, string][])),
];

describe("UglyCash reader", () => {
  const rows: [string, string, string][] = [
    ["10/02/2026", "Virtual Deposit abcd1234", "+$50.00"],
    ["10/03/2026", "Card SHOP DEMO efgh5678", "-$20.00"],
    ["10/04/2026", "Payvalida Deposit ijkl9012", "+$10.00"],
    ["10/05/2026", "Card PENDING DEMO mnop3456 AUTH $9.99", "9.99"],
    ["10/06/2026", "Card CAFE DEMO qrst7890", "-$10.01"],
  ];
  it("keeps the per-month credits, debits and balance check, with its 2 cent tolerance", () => {
    const st = readStatement(ugly({ start: "100.00", credits: "60.00", debits: "30.00", rewards: "0.50", end: "130.51" }, rows))!;
    expect(st.kind).toBe("uglycash");
    expect(st.rows).toHaveLength(4); // the hold line has no sign and is skipped
    expect(st.rows.map((r) => [r.cents, r.tipo])).toEqual([[-5000, "ingreso"], [2000, null], [-1000, "interno"], [1001, null]]);
    expect(st.check.ok).toBe(true); // 30.01 vs 30.00 debits: inside 2 cents
    expect(st.period).toEqual({ start: "2026-10-01", end: "2026-10-31" });
  });
  it("fails when the month does not add up", () => {
    const st = readStatement(ugly({ start: "100.00", credits: "60.00", debits: "35.00", rewards: "0.00", end: "125.00" }, rows))!;
    expect(st.check.ok).toBe(false);
    expect(st.check.parts).toMatchObject({ credits: true, debits: false });
  });
});

const bac = (o: { previous: string; payments: string; closing: string; purchases: string; rows: [string, string, string, "c" | "a"][]; total: [string | null, string | null]; cut?: string }) =>
  page([
    [[40, "BAC CREDOMATIC"], [300, "RESUMEN DE MOVIMIENTOS"]],
    [[40, "FECHA DE CORTE"], [153, o.cut ?? "15/11/26"]],
    [[40, "4000-12XX-XXXX-0002"]],
    [[205, "SALDO ANTERIOR"], [357, "$"], [385, o.previous]],
    [[205, "COMPRAS Y CUOTAS"], [357, "$"], [385, o.purchases]],
    [[205, "COMISIONES"], [357, "$"], [385, "0.00"]],
    [[205, "PAGOS Y DEPOSITOS"], [357, "$"], [385, o.payments]],
    [[205, "INTERESES SOBRE SALDO"], [357, "$"], [385, "0.00"]],
    [[205, "SALDO DE CONTADO"], [357, "$"], [385, o.closing]],
    [[38, "FECHA DE"], [90, "NUMERO DE"], [300, "CONCEPTO"], [500, "CARGOS"], [560, "ABONOS"]],
    ...o.rows.map(([d, ref, concept, amt]) => {
      const cells: [number, string][] = [[38.9, d], [76.9, ref], [148, "A001"], [172, concept]];
      if (amt.startsWith("c")) cells.push([471, "$"], [500, amt.slice(1)]);
      else cells.push([533, "$"], [561, amt.slice(1)]);
      return cells;
    }),
    [[90, "TOTAL ...:"], ...(o.total[0] ? [[471, "$"], [500, o.total[0]]] as [number, string][] : []), ...(o.total[1] ? [[533, "$"], [561, o.total[1]]] as [number, string][] : [])],
  ]);

describe("BAC credit card reader", () => {
  const rows: [string, string, string, "c" | "a"][] = [
    ["OCT/16", "17/10 12345678", "TIENDA DEMO", "c12.34" as "c"],
    ["NOV/02", "02/11 123456789A001", "SU PAGO EN LINEA", "a100.00" as "a"],
  ];
  it("reads charges and payments by column, and the payment is internal", () => {
    const st = readStatement([bac({ previous: "100.00", purchases: "12.34", payments: "100.00", closing: "12.34", rows, total: ["12.34", "100.00"] })])!;
    expect(st.kind).toBe("bac_tc");
    expect(st.card).toBe("0002");
    expect(st.rows.map((r) => [r.fecha, r.cents, r.tipo, r.comercio])).toEqual([
      ["2026-10-16", 1234, null, "TIENDA DEMO"],
      ["2026-11-02", -10000, "interno", "SU PAGO EN LINEA"],
    ]);
    expect(st.check).toMatchObject({ ok: true, expected: -8766, got: -8766, parts: { total_line: true, summary: true } });
  });
  it("accounts for last month's waived interest, which BAC credits without a row", () => {
    const st = readStatement([bac({ previous: "103.00", purchases: "12.34", payments: "103.00", closing: "12.34", rows, total: ["12.34", "100.00"] })])!;
    expect(st.check).toMatchObject({ ok: true, credit: 300 });
  });
  it("does not add up when a row is missing", () => {
    const st = readStatement([bac({ previous: "100.00", purchases: "12.34", payments: "100.00", closing: "12.34", rows: rows.slice(0, 1), total: ["12.34", "100.00"] })])!;
    expect(st.check.ok).toBe(false);
    expect(st.check.parts?.total_line).toBe(false);
  });
  it("puts December rows of a January statement in the year before", () => {
    const st = readStatement([bac({ previous: "0.00", purchases: "12.34", payments: "0.00", closing: "12.34", cut: "15/01/27", rows: [["DIC/20", "21/12 12345678", "TIENDA DEMO", "c12.34" as "c"]], total: ["12.34", null] })])!;
    expect(st.rows[0].fecha).toBe("2026-12-20");
    expect(st.check.ok).toBe(true);
  });
  it("knows no reader for an unknown file", () => {
    expect(detect(itemsToLines([page([[[40, "HELLO"]]])]))).toBeNull();
    expect(readStatement([page([[[40, "HELLO"]]])])).toBeNull();
  });
});

describe("masking", () => {
  it("long digit runs keep only their last 4", () => {
    expect(maskDigits("REF 123456789 CARD 4000-1234-5678-9010")).toBe("REF ••••6789 CARD ••••9010");
    expect(maskDigits("SHOP 0123")).toBe("SHOP 0123");
  });
});

describe("CSV reader", () => {
  const text = '﻿Fecha,Descripción,Monto,Saldo\n05/10/2026,"SUPER DEMO, SUCURSAL",-12.50,87.50\n06/10/2026,DEPOSITO DEMO,100.00,187.50\n07/10/2026,CAFE DEMO,-2.00,185.50\n';
  it("parses quotes, guesses the columns and checks each balance", () => {
    const t = parseCsv(text);
    expect(t.header).toEqual(["Fecha", "Descripción", "Monto", "Saldo"]);
    const map = guessMap(t.header, t.rows);
    expect(map).toMatchObject({ fecha: 0, comercio: 1, monto: 2, saldo: 3, order: "dmy", sign: "out_negative" });
    const st = readCsv(t, map);
    expect(st.rows.map((r) => [r.fecha, r.comercio, r.cents])).toEqual([
      ["2026-10-05", "SUPER DEMO, SUCURSAL", 1250],
      ["2026-10-06", "DEPOSITO DEMO", -10000],
      ["2026-10-07", "CAFE DEMO", 200],
    ]);
    expect(st.check.ok).toBe(true);
  });
  it("names the first line where the balance breaks", () => {
    const t = parseCsv(text.replace("185.50", "186.50"));
    const st = readCsv(t, guessMap(t.header, t.rows));
    expect(st.check).toMatchObject({ ok: false, line: 4 });
  });
  it("reads separate charge and credit columns, semicolons and month-first dates", () => {
    const t = parseCsv("Date;Description;Debit;Credit\n10/13/2026;SHOP DEMO;1.234,50;\n10/14/2026;REFUND DEMO;;3,00\n");
    const map = guessMap(t.header, t.rows);
    expect(map).toMatchObject({ order: "mdy", cargo: 2, abono: 3, monto: null });
    expect(readCsv(t, map).rows.map((r) => r.cents)).toEqual([123450, -300]);
    expect(readCsv(t, map).check.ok).toBeNull(); // no balance column: nothing to check against
  });
  it("refuses more than 2,000 rows", () => {
    const big = "Fecha,Monto\n" + Array.from({ length: 2001 }, () => "01/10/2026,1.00").join("\n");
    expect(() => parseCsv(big)).toThrow("too_many_rows");
    expect(parseCsv("Fecha,Monto\n" + Array.from({ length: 2000 }, () => "01/10/2026,1.00").join("\n")).rows).toHaveLength(2000);
  });
  it("reads amounts and dates in the usual bank shapes", () => {
    expect([amountCents("$1,234.56"), amountCents("(12.00)"), amountCents("12,5"), amountCents("7.00-"), amountCents("abc")]).toEqual([123456, -1200, 1250, -700, null]);
    expect([dateOf("31/12/26", "dmy"), dateOf("2026-02-30", "dmy"), dateOf("12/31/2026", "mdy")]).toEqual(["2026-12-31", null, "2026-12-31"]);
    expect(headerText(["Fecha ", "Descripción"])).toBe("fecha|descripcion");
  });
});

describe("fixed payments", () => {
  const r = (merchant_key: string, fecha: string, amount_cents: number) => ({ merchant_key, comercio: merchant_key.toUpperCase(), fecha, amount_cents });
  it("finds the same shop with a similar amount at a regular gap", () => {
    const found = findRecurring([
      r("streaming demo", "2026-08-03", 1099), r("streaming demo", "2026-09-03", 1099), r("streaming demo", "2026-10-04", 1099),
      r("gym demo", "2026-09-01", 2500), r("gym demo", "2026-10-01", 2500),
      r("cafe demo", "2026-10-01", 250), r("cafe demo", "2026-10-02", 300), r("cafe demo", "2026-10-09", 275), r("cafe demo", "2026-10-30", 260),
      r("super demo", "2026-09-01", 4000), r("super demo", "2026-10-01", 9500),
      r("weekly demo", "2026-10-01", 500), r("weekly demo", "2026-10-08", 520), r("weekly demo", "2026-10-15", 500),
    ]);
    expect(found.map((f) => [f.merchant_key, f.every_days, f.amount_cents])).toEqual([
      ["gym demo", 30, 2500], ["streaming demo", 30, 1099], ["weekly demo", 7, 500],
    ]);
    expect(found.find((f) => f.merchant_key === "streaming demo")!.next_fecha).toBe("2026-11-04");
    expect(monthlyCents({ amount_cents: 500, every_days: 7 })).toBe(2173);
  });
  it("needs three weekly payments and leaves out irregular ones", () => {
    expect(findRecurring([r("w", "2026-10-01", 500), r("w", "2026-10-08", 500)])).toEqual([]);
    expect(findRecurring([r("m", "2026-08-01", 500), r("m", "2026-09-01", 500), r("m", "2026-09-20", 500)])).toEqual([]);
  });
});

describe("Primeros pasos math", () => {
  it("averages use full months only, at most the last 3", () => {
    expect(fullMonths("2026-07-15", "2026-11-25")).toEqual(["2026-08", "2026-09", "2026-10"]);
    expect(fullMonths("2026-10-01", "2026-11-25")).toEqual(["2026-10"]);
    expect(fullMonths("2026-10-02", "2026-11-25")).toEqual([]);
    expect(fullMonths("2025-12-01", "2026-01-10")).toEqual(["2025-12"]);
    expect(fullMonths(null, "2026-11-25")).toEqual([]);
  });
  it("limits round to $5", () => {
    expect([roundTo5(0), roundTo5(249), roundTo5(250), roundTo5(12345), roundTo5(-100)]).toEqual([0, 0, 500, 12500, 0]);
    expect(limitChoices(23710)).toEqual({ same: 23500, less10: 21500, less20: 19000 });
  });
  it("starter rules map shops to the starter category names", () => {
    expect(starterCategory("SUPER DEMO 01")).toBe("Supermercado");
    expect(starterCategory("UBER *ONE")).toBe("Suscripciones");
    expect(starterCategory("UBER TRIP")).toBe("Uber, taxi y bus");
    expect(starterCategory("SOMETHING ELSE")).toBeNull();
  });
});

describe("rows sent to the server", () => {
  const row = (fecha: string, cents: number, comercio = "Tienda Demo", tipo: "interno" | "ingreso" | null = null) => ({ fecha, comercio, cents, tipo, ref: "" });
  it("sends whole cents and a direction, masks long digit runs and keeps only interno and incoming ingreso", () => {
    const out = apiRows({ rows: [row("2026-03-02", 1250, "PAGO 4000123412341234"), row("2026-03-01", -900, "Salario Demo", "ingreso"),
      row("2026-03-01", 0), row("2026-03-03", 5000, "Pago tarjeta", "interno"), row("2026-03-04", 700, "Raro", "ingreso")] });
    expect(out).toEqual([
      { fecha: "2026-03-01", comercio: "Salario Demo", cents: 900, dir: "in", tipo: "ingreso" },
      { fecha: "2026-03-02", comercio: maskDigits("PAGO 4000123412341234"), cents: 1250, dir: "out" },
      { fecha: "2026-03-03", comercio: "Pago tarjeta", cents: 5000, dir: "out", tipo: "interno" },
      { fecha: "2026-03-04", comercio: "Raro", cents: 700, dir: "out" },
    ]);
    expect(out[1].comercio).not.toMatch(/\d{5,}/);
  });
  it("chunks by rows and bytes without splitting a group of equal rows", () => {
    const rows = apiRows({ rows: [row("2026-03-01", 100), row("2026-03-01", 100), row("2026-03-01", 100), row("2026-03-02", 200), row("2026-03-03", 300)] });
    const chunks = chunkRows(rows, { maxRows: 2 });
    expect(chunks.map((c) => c.length)).toEqual([3, 2]); // the three equal rows stay together
    expect(chunks.flat()).toEqual(rows);
    const long = apiRows({ rows: Array.from({ length: 1200 }, (_, i) => row(`2026-03-${String(1 + (i % 28)).padStart(2, "0")}`, 100 + i, "X".repeat(120))) });
    const big = chunkRows(long);
    expect(big.every((c) => c.length <= CHUNK_ROWS && JSON.stringify(c).length <= CHUNK_BYTES + 2)).toBe(true);
    expect(big.flat().length).toBe(1200);
    expect(monthsOf({ start: "2026-11-20", end: "2027-01-19" })).toEqual(["2026-11", "2026-12", "2027-01"]);
  });
});
