// Wave 2 (audit Nov 25): import regressions that the audit repro tests do not already cover.
import { describe, expect, it } from "vitest";
import { compatible, planRows, tipoOf, askIn } from "../src/lib/importing.ts";
import { readStatement, type Page } from "../public/import/parse.js";

const ex = (id: number, fecha: string, origen: string, tipo = "gasto", cents = 250) =>
  ({ id, fecha, tipo, origen, dedupe_key: `k${id}`, amount_cents: cents }) as any;

describe("F01: near matches", () => {
  it("an email row a day apart is still the same purchase", () => {
    const p = planRows(1, "bac_tc", [{ fecha: "2026-10-06", comercio: "X", cents: 250, dir: "out" }], [ex(7, "2026-10-05", "correo BAC")], new Set(), new Map());
    expect([p[0].outcome, p[0].claim]).toEqual(["already", 7]);
  });
  it("a row from an earlier statement only counts on the same date", () => {
    const rows = [{ fecha: "2026-10-15", comercio: "X", cents: 250, dir: "out" as const }];
    expect(planRows(1, "bac_tc", rows, [ex(7, "2026-10-14", "estado de cuenta")], new Set(), new Map())[0].outcome).toBe("added");
    expect(planRows(1, "bac_tc", rows, [ex(7, "2026-10-14", "archivo CSV")], new Set(), new Map())[0].outcome).toBe("added");
    expect(planRows(1, "bac_tc", rows, [ex(7, "2026-10-15", "estado de cuenta")], new Set(), new Map())[0].outcome).toBe("already");
  });
});

describe("F10: only a typed gasto merges", () => {
  const rows = [{ fecha: "2026-10-05", comercio: "X", cents: 250, dir: "out" as const }];
  it("a typed gasto and a typed transfer: the gasto merges", () => {
    const p = planRows(1, "csv", rows, [ex(3, "2026-10-05", "manual", "interno"), ex(4, "2026-10-06", "manual", "gasto")], new Set(), new Map());
    expect([p[0].outcome, p[0].claim]).toEqual(["merged", 4]);
  });
  it("two typed gastos go to Revisar, a typed transfer next to them is not a candidate", () => {
    const p = planRows(1, "csv", rows, [ex(3, "2026-10-05", "manual", "gasto"), ex(4, "2026-10-06", "manual", "gasto"), ex(5, "2026-10-05", "manual", "interno")], new Set(), new Map());
    expect([p[0].outcome, p[0].candidates]).toEqual(["review", [3, 4]]);
  });
  it("a typed ignored row is the record", () => {
    const p = planRows(1, "csv", rows, [ex(3, "2026-10-05", "manual", "ignorado")], new Set(), new Map());
    expect([p[0].outcome, p[0].claim]).toEqual(["already", 3]);
    expect(compatible("out", "ignorado")).toBe(true);
  });
});

describe("F09: money in", () => {
  const inRow = { fecha: "2026-10-05", cents: 100, dir: "in" as const };
  it("only card statements make refunds", () => {
    expect(tipoOf(inRow, "bac_tc")).toBe("abono");
    expect(tipoOf(inRow, "agricola_tc")).toBe("abono");
    expect(tipoOf(inRow, "uglycash")).toBe("ingreso");
    expect(tipoOf(inRow, "csv")).toBe("ingreso");
    expect([askIn(inRow, "uglycash"), askIn(inRow, "bac_tc"), askIn({ ...inRow, tipo: "ingreso" }, "uglycash")]).toEqual([true, false, false]);
  });
});

describe("F54: wallet references", () => {
  const page = (desc: string) => {
    const items = [
      { s: "UglyCash", x: 40, y: 730 },
      { s: "Balance on 3/1", x: 40, y: 714 }, { s: "$0.00", x: 260, y: 714 },
      { s: "Credits", x: 40, y: 698 }, { s: "+$1.00", x: 260, y: 698 },
      { s: "Debits", x: 40, y: 666 }, { s: "-$0.00", x: 260, y: 666 },
      { s: "Balance on 3/31", x: 40, y: 650 }, { s: "$1.00", x: 260, y: 650 },
      { s: "03/04/2026", x: 40, y: 602 }, { s: desc, x: 150, y: 602 }, { s: "+$1.00", x: 400, y: 602 },
    ].map((i) => ({ ...i, w: i.s.length * 5, h: 8 }));
    return readStatement([{ items }] as Page[])!;
  };
  it("a plain last word stays; a code with a digit is the reference", () => {
    expect(page("Incoming transfer").rows[0].comercio).toBe("Incoming transfer");
    const r = page("Shop a1b2c3d4").rows[0];
    expect([r.comercio, r.ref]).toEqual(["Shop", "a1b2c3d4"]);
  });
});
