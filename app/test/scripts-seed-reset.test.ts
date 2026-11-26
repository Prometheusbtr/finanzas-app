// Wave 6 regression tests: F48 (seed rows checked like the app) and F49 (reset of a missing name fails).
import { describe, expect, it } from "vitest";
import { seedHora, seedRowShape } from "../src/lib/seedrow.ts";
import { resetLoginSql } from "../src/lib/users.ts";
import { env } from "cloudflare:workers";
import { makeUser } from "./helpers.ts";

const db = () => env.DB;

describe("F48 seed rows", () => {
  it("reads the times the ledger has and refuses the rest", () => {
    expect(seedHora("9:05")).toBe("09:05");
    expect(seedHora("09:05:33")).toBe("09:05");
    expect(seedHora("")).toBe(null);
    expect(seedHora(null)).toBe(null);
    expect(seedHora("24:00")).toBe(undefined);
    expect(seedHora("9h05")).toBe(undefined);
  });
  it("skips a bad date or type, keeps a good row", () => {
    expect(seedRowShape({ fecha: "2026-02-30", hora: "", tipo: "gasto" })).toBe(null);
    expect(seedRowShape({ fecha: "26-02-03", hora: "", tipo: "gasto" })).toBe(null);
    expect(seedRowShape({ fecha: "2026-02-03", hora: "", tipo: "compra" })).toBe(null);
    expect(seedRowShape({ fecha: "2026-02-03", hora: "7:30", tipo: "abono" })).toEqual({ fecha: "2026-02-03", hora: "07:30", tipo: "abono" });
  });
  it("the seed INSERT form skips a row seeded before and stops on a CHECK failure", async () => {
    const u = await makeUser("seedf48");
    const name = (await db().prepare("SELECT username FROM users WHERE id = ?").bind(u.id).first<{ username: string }>())!.username;
    const ins = (fecha: string) =>
      `INSERT INTO movements (user_id, fecha, hora, amount_cents, tipo, origen, estado, dedupe_key, created_at, updated_at) ` +
      `SELECT u.id, '${fecha}', NULL, 100, 'gasto', 'seed', 'ok', 'seed:f48|1', 1, 1 FROM users u WHERE u.username = '${name}' ` +
      `ON CONFLICT (user_id, dedupe_key) DO NOTHING`;
    await db().prepare(ins("2026-02-03")).run();
    await db().prepare(ins("2026-02-03")).run(); // the same row again: skipped
    const n = await db().prepare("SELECT COUNT(*) AS n FROM movements WHERE user_id = ? AND dedupe_key = 'seed:f48|1'").bind(u.id).first<{ n: number }>();
    expect(n!.n).toBe(1);
    await expect(db().prepare(ins("bad").replace("seed:f48|1", "seed:f48|2")).run()).rejects.toThrow(/CHECK/);
  });
});

describe("F49 add-user --reset", () => {
  it("a name that does not exist stops with an error; a real name gets the new login", async () => {
    await expect(db().exec(resetLoginSql("no-such-user-f49", "salt", "hash").replace(/\n/g, " "))).rejects.toThrow(/NOT NULL/);
    const u = await makeUser("resetf49");
    const name = (await db().prepare("SELECT username FROM users WHERE id = ?").bind(u.id).first<{ username: string }>())!.username;
    await db().exec(resetLoginSql(name, "s-f49", "h-f49").replace(/\n/g, " "));
    const row = await db().prepare("SELECT pass_salt, pass_hash FROM users WHERE id = ?").bind(u.id).first<{ pass_salt: string; pass_hash: string }>();
    expect(row).toEqual({ pass_salt: "s-f49", pass_hash: "h-f49" });
  });
});
