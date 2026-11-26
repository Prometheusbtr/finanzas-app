// Audit IMPORT: the phone's CSV and PDF readers on odd made-up files. Pure functions, no database.
import { describe, expect, it } from "vitest";
import { amountCents, dateOf, guessMap, parseCsv, readCsv } from "../public/import/csv.js";
import { readStatement, type Page } from "../public/import/parse.js";
import { apiRows, chunkRows, CHUNK_BYTES } from "../public/import/upload.js";

const read = (text: string) => {
  const t = parseCsv(text);
  const map = guessMap(t.header, t.rows);
  return { t, map, st: readCsv(t, map) };
};

describe("audit IMPORT readers", () => {
  it("F05: split columns, a malformed debit becomes 0 and the row vanishes without a bad line; one balance says it agrees", () => {
    const { st, map } = read("Fecha,Cargo,Abono,Descripcion,Saldo\n2026-03-01,12.34,,Valid item,87.66\n2026-03-02,unknown,,Unread item,82.66\n");
    console.log("FACT f05_split", JSON.stringify({ map: { cargo: map.cargo, abono: map.abono, saldo: map.saldo }, rows: st.rows.length, bad: st.bad, check: st.check }));
    expect(st.rows.length).toBe(1);
    expect(st.bad).toEqual([3]); // F02 fixed: the unreadable debit is a bad line
    expect(st.check.ok).not.toBe(true);
  });

  it("F05: single column, an unreadable LAST row goes to bad (never shown) and the balance still agrees", () => {
    const text = "Fecha,Descripcion,Monto,Saldo\n01/03/2026,A,-10.00,90.00\n02/03/2026,B,-5.00,85.00\n03/03/2026,C,-7.0O,78.00\n";
    const { st } = read(text);
    console.log("FACT f05_last", JSON.stringify({ rows: st.rows.length, bad: st.bad, check: st.check }));
    expect(st.bad).toEqual([4]);
    expect(st.check).toEqual({ ok: null, label: "bad_lines" });
  });

  it("F05: a statement whose FIRST row is unreadable also agrees (the edges are never compared)", () => {
    const { st } = read("Fecha,Descripcion,Monto,Saldo\n01/03/2026,A,-10.0O,90.00\n02/03/2026,B,-5.00,85.00\n03/03/2026,C,-7.00,78.00\n");
    console.log("FACT f05_first", JSON.stringify({ rows: st.rows.length, bad: st.bad, ok: st.check.ok }));
    expect(st.check.ok).not.toBe(true);
    expect(st.bad!.length).toBe(1);
  });

  it("odd but fine shapes: BOM, semicolons, quoted commas, 1.234,56, parentheses, trailing minus, CRLF, blank lines, reversed order", () => {
    const text = "﻿Fecha;Concepto;Importe;Saldo\r\n\r\n03/03/2026;\"C, sucursal\";(1.234,56);8.765,44\r\n02/03/2026;B;5,00-;10.000,00\r\n\r\n01/03/2026;A;100,00;10.005,00\r\n";
    const { st, map } = read(text);
    console.log("FACT odd_ok", JSON.stringify({ delimiter: parseCsv(text).delimiter, map, cents: st.rows.map((r) => r.cents), check: st.check.ok }));
    expect(st.rows.map((r) => r.cents)).toEqual([123456, 500, -10000]);
    expect(st.check.ok).toBe(true);
  });

  it("amount and date corner cases", () => {
    const facts = {
      eu_thousands_no_decimals: amountCents("1.234"), // read as null (a bad line), not 1.234
      us_thousands_no_decimals: amountCents("1,234"),
      unicode_minus: amountCents("−12.34"),
      cr_suffix: amountCents("12.34 CR"),
      nbsp: amountCents("1 234,50"),
      ambiguous_date_dmy: dateOf("02/03/2026", "dmy"),
      two_digit_year: dateOf("31/12/26", "dmy"),
    };
    console.log("FACT amounts", JSON.stringify(facts));
    expect(facts.eu_thousands_no_decimals).toBeNull();
  });

  it("a card CSV with positive charges and a negative payment: the sign guess turns every purchase into money in", () => {
    const { st, map } = read("Date,Description,Amount\n10/01/2026,QA Shop A,25.00\n10/02/2026,QA Shop B,40.00\n10/05/2026,PAYMENT THANK YOU,-65.00\n");
    const dirs = apiRows(st).map((r) => [r.comercio, r.dir]);
    console.log("FACT card_sign", JSON.stringify({ sign: map.sign, dirs, check: st.check }));
    expect(map.sign).toBe("out_positive"); // F51 fixed: the more common sign is spending
    expect(dirs).toEqual([["QA Shop A", "out"], ["QA Shop B", "out"], ["PAYMENT THANK YOU", "in"]]);
  });

  it("UglyCash: with no 'Balance on' lines the missing balances count as $0 and the check passes", () => {
    const items = [
      { s: "UglyCash", x: 40, y: 730 },
      { s: "Credits", x: 40, y: 698 }, { s: "+$12.34", x: 260, y: 698 },
      { s: "Debits", x: 40, y: 666 }, { s: "-$12.34", x: 260, y: 666 },
      { s: "03/02/2026", x: 40, y: 634 }, { s: "QA Shop Beta", x: 150, y: 634 }, { s: "-$12.34", x: 400, y: 634 },
      { s: "03/04/2026", x: 40, y: 602 }, { s: "QA Incoming", x: 150, y: 602 }, { s: "+$12.34", x: 400, y: 602 },
    ].map((i) => ({ ...i, w: i.s.length * 5, h: 8 }));
    const st = readStatement([{ items }] as Page[])!;
    console.log("FACT ugly_nobal", JSON.stringify({ kind: st.kind, rows: st.rows.length, check: st.check, summary: st.summary }));
    expect(st.check).toEqual({ ok: null, label: "no_balance" }); // F50 fixed
  });

  it("chunk size counts UTF-16 units, not the UTF-8 bytes the 64 KB body limit counts", () => {
    // 400 rows, each with one masked reference (each bullet is 3 bytes) and accented letters.
    const rows = Array.from({ length: 400 }, (_, i) => ({
      fecha: "2026-10-05", cents: 100 + i, comercio: `COMPRA ÑANDÚ ÁÉÍÓÚ ${"9".repeat(12)} ${"8".repeat(12)} ${"7".repeat(12)} ÁÉÍÓÚÑ ÁÉÍÓÚÑ ÁÉÍÓÚÑ ÁÉÍÓÚÑ`, tipo: null, ref: "",
    }));
    const chunks = chunkRows(apiRows({ rows }));
    const sizes = chunks.map((c) => ({ units: JSON.stringify({ part: 0, rows: c }).length, bytes: new TextEncoder().encode(JSON.stringify({ part: 0, rows: c })).length }));
    console.log("FACT chunk_bytes", JSON.stringify({ CHUNK_BYTES, sizes }));
    expect(sizes.every((s) => s.bytes <= 57 * 1024)).toBe(true); // F55 fixed: bytes, not UTF-16 units
    expect(chunks.flat().length).toBe(400);
  });
});
