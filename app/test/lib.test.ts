import { describe, expect, it } from "vitest";
import { generatePassphrase, LOCK_MS, MAX_FAILURES, normalizePassphrase, windowState } from "../src/lib/auth.ts";
import { isValidFecha, monthBounds, shiftDays, svNow } from "../src/lib/dates.ts";
import { merchantKey } from "../src/lib/merchant.ts";
import { centsToText, parseCents } from "../src/lib/money.ts";

describe("money", () => {
  it("parses amounts into whole cents", () => {
    expect(parseCents("12")).toBe(1200);
    expect(parseCents("12.5")).toBe(1250);
    expect(parseCents("12.05")).toBe(1205);
    expect(parseCents("$1,234.56")).toBe(123456);
    expect(parseCents("3,50")).toBe(350); // decimal comma
    expect(parseCents(" 0.01 ")).toBe(1);
    expect(parseCents("1820.85")).toBe(182085);
  });
  it("rejects anything unclear", () => {
    for (const bad of ["", "abc", "-5", "1.234", "1,2,3", "12.", ".5", "1e3", "100000.01"]) expect(parseCents(bad)).toBeNull();
  });
  it("formats cents", () => {
    expect(centsToText(123456)).toBe("1,234.56");
    expect(centsToText(-5)).toBe("-0.05");
  });
});

describe("dates (El Salvador, UTC-6)", () => {
  it("uses the local date, not UTC", () => {
    // 03:00 UTC on Nov 25 is 21:00 on Nov 24 in El Salvador
    expect(svNow(Date.UTC(2026, 10, 25, 3, 0))).toEqual({ fecha: "2026-11-24", hora: "21:00" });
    expect(svNow(Date.UTC(2026, 10, 25, 6, 0))).toEqual({ fecha: "2026-11-25", hora: "00:00" });
  });
  it("shifts days and months", () => {
    expect(shiftDays("2026-11-30", 3)).toBe("2026-12-03");
    expect(shiftDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(monthBounds("2026-02")).toEqual({ start: "2026-02-01", end: "2026-02-28", days: 28 });
    expect(monthBounds("2028-02").days).toBe(29);
    expect(isValidFecha("2026-02-30")).toBe(false);
    expect(isValidFecha("2026-12-31")).toBe(true);
  });
});

describe("merchant key", () => {
  it("groups the same shop with different branch numbers and accents", () => {
    expect(merchantKey("SUPER SELECTOS 0123")).toBe(merchantKey("Super Selectos 0456"));
    expect(merchantKey("Café  Ñandú")).toBe("cafe nandu");
    expect(merchantKey("DOLLAR CITY RAMBLAS SA")).toBe("dollar city ramblas sa");
  });
});

describe("login lockout rule", () => {
  it("allows 5 tries in 15 minutes, locks on the 5th wrong one, then starts again", () => {
    const start = 1_000_000;
    for (let tries = 1; tries < MAX_FAILURES; tries++) {
      const st = windowState(tries, start, start + tries, MAX_FAILURES, LOCK_MS);
      expect(st).toMatchObject({ allowed: true, last: false, triesLeft: MAX_FAILURES - tries });
    }
    expect(windowState(MAX_FAILURES, start, start, MAX_FAILURES, LOCK_MS)).toMatchObject({ allowed: true, last: true, triesLeft: 0 });
    const locked = windowState(MAX_FAILURES + 1, start, start + 1000, MAX_FAILURES, LOCK_MS);
    expect(locked.allowed).toBe(false);
    expect(locked.retryAfterS).toBe(LOCK_MS / 1000 - 1);
  });
});

describe("passphrase", () => {
  it("is 25 random characters in 5 groups and forgiving to type", () => {
    const p = generatePassphrase();
    expect(p).toMatch(/^[a-z2-9]{5}(-[a-z2-9]{5}){4}$/);
    expect(generatePassphrase()).not.toBe(p);
    expect(normalizePassphrase(" ABCDE fghjk-MNPQR ")).toBe("abcdefghjkmnpqr");
  });
});
