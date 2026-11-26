// Wave 1 (audit Nov 25 2026): the amounts and rates she types (F05, F18, F25, F36, F38).
import { describe, expect, it } from "vitest";
import { isZero, parseCents, parseRate } from "../public/js/numbers.js";

describe("parseRate (F05)", () => {
  it("comma decimals and comma thousands give the same rate as plain numbers", () => {
    expect(parseRate("1,25", "CAD")).toEqual({ rate: 1.25 });
    expect(parseRate("1.25", "CAD")).toEqual({ rate: 1.25 });
    expect(parseRate("0,92", "EUR")).toEqual({ rate: 0.92 });
    expect(parseRate("4,400", "COP")).toEqual({ rate: 4400 });
    expect(parseRate("4400", "COP")).toEqual({ rate: 4400 });
    expect(parseRate("1,234.5", "COP")).toEqual({ rate: 1234.5 });
    expect(Math.round(parseRate("1,25", "CAD").rate! * 1e6)).toBe(1250000);
    expect(Math.round(parseRate("0,92", "EUR").rate! * 1e6)).toBe(920000);
    expect(Math.round(parseRate("4,400", "COP").rate! * 1e6)).toBe(4400000000);
  });
  it("a Colombian thousands dot is asked about for COP, never read as 4.4", () => {
    expect(parseRate("4.400", "COP")).toEqual({ error: "fnFxRateDot", x: "4400" });
    expect(parseRate("4.400", "CRC")).toEqual({ rate: 4.4 }); // CRC is about 500 a dollar: no thousands mark (Seguridad)
    expect(parseRate("1.365", "CAD")).toEqual({ rate: 1.365 }); // a real 3-decimal rate elsewhere
  });
  it("malformed or empty", () => {
    expect(parseRate("1,2,3", "CAD")).toEqual({ error: "fnFxBadRate" });
    expect(parseRate("1.234,56", "CAD")).toEqual({ error: "fnFxBadRate" });
    expect(parseRate("abc", "CAD")).toEqual({ error: "fnFxBadRate" });
    expect(parseRate("0", "CAD")).toEqual({ error: "fnFxNeedRate" });
    expect(parseRate("  ", "CAD")).toEqual({ rate: null });
  });
});

describe("parseCents options (F18, F25, F36, F38)", () => {
  it("another currency's amount goes past the dollar cap; dollars do not", () => {
    expect(parseCents("4,400,000.00", { max: 1e14 })).toBe(440000000);
    expect(parseCents("150000", { max: 1e14 })).toBe(15000000);
    expect(parseCents("100,000.01")).toBe(null);
    expect(parseCents("100000")).toBe(10000000);
  });
  it("zero only where it is allowed", () => {
    for (const z of ["0", "0.00", "0,0", "00", "$0"]) {
      expect(isZero(z)).toBe(true);
      expect(parseCents(z, { zero: true })).toBe(0);
      expect(parseCents(z)).toBe(null);
    }
    expect(parseCents("abc", { zero: true })).toBe(null);
    expect(parseCents("1,5", { zero: true })).toBe(150);
  });
});
