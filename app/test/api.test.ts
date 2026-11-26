import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { ingestBankMovement } from "../src/lib/merge.ts";
import { nameKey } from "../src/lib/auth.ts";
import { call, ipFor, json, login, makeUser, PASS } from "./helpers.ts";

const bank = (o: Partial<Parameters<typeof ingestBankMovement>[2]> & { account_id: number; amount_cents: number; fecha: string }) => ({
  dedupe_key: `bac:${o.fecha}:${o.amount_cents}:${Math.random()}`,
  hora: "12:00", tipo: "gasto" as const, comercio: "SUPER SELECTOS 0123", origen: "correo BAC", raw: "Alerta PRF BAC Credomatic ...",
  ...o,
});

describe("login", () => {
  it("needs a session for data", async () => {
    expect((await call("GET", "/api/bootstrap")).status).toBe(401);
    expect((await call("GET", "/api/movements", undefined, "__Host-fz_s=forged-token")).status).toBe(401);
  });

  it("locks after 5 wrong tries, even with the right passphrase, and opens again after 15 minutes", async () => {
    const u = await makeUser("lock");
    for (let i = 1; i <= 4; i++) {
      const r = await login(u.username, "wrong-pass");
      expect(r.status).toBe(401);
      expect((await json(r)).tries_left).toBe(5 - i);
    }
    expect((await login(u.username, "wrong-pass")).status).toBe(429); // 5th wrong try locks
    const blocked = await login(u.username, PASS);
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(14 * 60);
    // Pretend 15 minutes passed.
    const k = await nameKey(u.username, ipFor(u.username));
    await env.DB.prepare("UPDATE login_limits SET window_start = window_start - ? WHERE k = ?").bind(15 * 60 * 1000 + 1, k).run();
    expect((await login(u.username, PASS)).status).toBe(200);
    expect(await env.DB.prepare("SELECT * FROM login_limits WHERE k = ?").bind(k).first()).toBeNull();
  });

  it("treats unknown usernames the same way (no hint that a name exists)", async () => {
    const r = await login("nobody-here", PASS);
    expect(r.status).toBe(401);
    expect(await json(r)).toEqual({ error: "bad_login", tries_left: 4 });
  });

  it("accepts the passphrase typed with capitals or spaces", async () => {
    const u = await makeUser("case");
    expect((await login(u.username.toUpperCase(), PASS.toUpperCase().replace(/-/g, " "))).status).toBe(200);
  });

  it("logs out", async () => {
    const u = await makeUser("out");
    expect((await call("POST", "/api/logout", {}, u.cookie)).status).toBe(200);
    expect((await call("GET", "/api/bootstrap", undefined, u.cookie)).status).toBe(401);
  });

  it("refuses writes that are not JSON or come from another site", async () => {
    const u = await makeUser("csrf");
    const form = await call("POST", "/api/movements", undefined, u.cookie, { "content-type": "application/x-www-form-urlencoded" });
    expect(form.status).toBe(415);
    const other = await call("POST", "/api/movements", { client_id: "abcdefgh1", amount_cents: 100, account_id: u.accountId }, u.cookie, { origin: "https://evil.example" });
    expect(other.status).toBe(403);
  });
});

describe("user isolation", () => {
  it("one user cannot see, change or use another user's data", async () => {
    const a = await makeUser("a");
    const b = await makeUser("b");
    const created = await json(call("POST", "/api/movements", {
      client_id: "iso-test-0001", amount_cents: 4321, account_id: a.accountId, category_id: a.cats["Supermercado"], comercio: "SECRETO DE A",
    }, a.cookie));
    const id = created.movement.id;

    expect((await call("GET", `/api/movements/${id}`, undefined, b.cookie)).status).toBe(404);
    expect((await call("PUT", `/api/movements/${id}`, { nota: "hack" }, b.cookie)).status).toBe(404);
    expect((await call("DELETE", `/api/movements/${id}`, {}, b.cookie)).status).toBe(404);
    const list = await json(call("GET", "/api/movements", undefined, b.cookie));
    expect(list.items).toHaveLength(0);
    const csv = await (await call("GET", "/api/export.csv", undefined, b.cookie)).text();
    expect(csv).not.toContain("SECRETO");
    const sum = await json(call("GET", `/api/summary?month=${created.movement.fecha.slice(0, 7)}`, undefined, b.cookie));
    expect(sum.spent_cents).toBe(0);

    // B cannot point at A's account or category.
    const useA = await call("POST", "/api/movements", { client_id: "iso-test-0002", amount_cents: 100, account_id: a.accountId }, b.cookie);
    expect(useA.status).toBe(400);
    const own = await json(call("POST", "/api/movements", { client_id: "iso-test-0003", amount_cents: 100, account_id: b.accountId }, b.cookie));
    expect((await call("PUT", `/api/movements/${own.movement.id}`, { category_id: a.cats["Supermercado"] }, b.cookie)).status).toBe(400);
    expect((await call("PUT", `/api/categories/${a.cats["Supermercado"]}`, { name: "x" }, b.cookie)).status).toBe(404);
    expect((await call("POST", `/api/movements/${own.movement.id}/merge`, { bank_id: id }, b.cookie)).status).toBe(404);

    // Same client_id used by two different users is fine: keys are per user.
    const sameKey = await call("POST", "/api/movements", { client_id: "iso-test-0001", amount_cents: 100, account_id: b.accountId }, b.cookie);
    expect(sameKey.status).toBe(201);

    // A still sees the untouched row.
    const mine = await json(call("GET", `/api/movements/${id}`, undefined, a.cookie));
    expect(mine.movement.nota).toBe("");
  });
});

describe("no duplicates", () => {
  it("saves a double-tapped purchase once", async () => {
    const u = await makeUser("dup");
    const body = { client_id: "double-tap-01", amount_cents: 250, account_id: u.otherAccountId, category_id: u.cats["Café y snacks"] };
    const first = await call("POST", "/api/movements", body, u.cookie);
    const second = await call("POST", "/api/movements", body, u.cookie);
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    const s = await json(second);
    expect(s.duplicate).toBe(true);
    expect(s.movement.id).toBe((await json(first)).movement.id);
    expect((await json(call("GET", "/api/movements", undefined, u.cookie))).items).toHaveLength(1);
  });

  it("saves the same bank email once", async () => {
    const u = await makeUser("dupb");
    const m = bank({ account_id: u.accountId, amount_cents: 999, fecha: "2026-11-20", dedupe_key: "bac:0000:2026-11-20T12:00:01:999" });
    expect((await ingestBankMovement(env.DB, u.id, m)).status).toBe("inserted");
    expect((await ingestBankMovement(env.DB, u.id, m)).status).toBe("duplicate");
  });
});

describe("typed and bank purchases merge", () => {
  it("merges one typed purchase with the bank one within 3 days and keeps the user's category", async () => {
    const u = await makeUser("mrg");
    const typed = await json(call("POST", "/api/movements", {
      client_id: "typed-merge-01", amount_cents: 1250, account_id: u.accountId, category_id: u.cats["Restaurantes"],
      fecha: "2026-11-20", nota: "almuerzo", comercio: "pupusas",
    }, u.cookie));
    const r = await ingestBankMovement(env.DB, u.id, bank({ account_id: u.accountId, amount_cents: 1250, fecha: "2026-11-22", comercio: "PUPUSERIA LA ESQUINA" }));
    expect(r.status).toBe("merged");
    const list = await json(call("GET", "/api/movements", undefined, u.cookie));
    expect(list.items).toHaveLength(1);
    const m = list.items[0];
    expect(m.origen).toBe("correo BAC");
    expect(m.comercio).toBe("PUPUSERIA LA ESQUINA");
    expect(m.category_id).toBe(u.cats["Restaurantes"]);
    expect(m.nota).toBe("almuerzo");
    expect(m.estado).toBe("ok");
    expect((await call("GET", `/api/movements/${typed.movement.id}`, undefined, u.cookie)).status).toBe(404);
    // The shop is remembered for next time.
    const sug = await json(call("GET", "/api/suggest?comercio=" + encodeURIComponent("Pupuseria La Esquina"), undefined, u.cookie));
    expect(sug.category_id).toBe(u.cats["Restaurantes"]);
  });

  it("does not merge across accounts, amounts or more than 3 days apart", async () => {
    const u = await makeUser("nomrg");
    await call("POST", "/api/movements", { client_id: "typed-nomerge-1", amount_cents: 500, account_id: u.accountId, fecha: "2026-11-10" }, u.cookie);
    expect((await ingestBankMovement(env.DB, u.id, bank({ account_id: u.accountId, amount_cents: 500, fecha: "2026-11-14" }))).status).toBe("inserted");
    expect((await ingestBankMovement(env.DB, u.id, bank({ account_id: u.otherAccountId, amount_cents: 500, fecha: "2026-11-10" }))).status).toBe("inserted");
    expect((await ingestBankMovement(env.DB, u.id, bank({ account_id: u.accountId, amount_cents: 501, fecha: "2026-11-10" }))).status).toBe("inserted");
    expect((await json(call("GET", "/api/movements", undefined, u.cookie))).items).toHaveLength(4);
  });

  it("asks when two typed purchases could match, then merges the chosen one", async () => {
    const u = await makeUser("ask");
    for (const [cid, f] of [["typed-ask-0001", "2026-11-19"], ["typed-ask-0002", "2026-11-21"]]) {
      await call("POST", "/api/movements", { client_id: cid, amount_cents: 300, account_id: u.accountId, fecha: f, category_id: u.cats["Café y snacks"] }, u.cookie);
    }
    const r = await ingestBankMovement(env.DB, u.id, bank({ account_id: u.accountId, amount_cents: 300, fecha: "2026-11-20", comercio: "CAFE X" }));
    expect(r.status).toBe("needs_review");
    const rev = await json(call("GET", "/api/review", undefined, u.cookie));
    expect(rev.suggestions).toHaveLength(2);
    expect(rev.items).toHaveLength(0); // the bank row shows as a question, not twice
    await call("POST", `/api/suggestions/${rev.suggestions[0].id}/accept`, {}, u.cookie);
    const after = await json(call("GET", "/api/review", undefined, u.cookie));
    expect(after.suggestions).toHaveLength(0);
    expect((await json(call("GET", "/api/movements", undefined, u.cookie))).items).toHaveLength(2);
  });

  it("offers the bank row when the purchase is typed after it arrived", async () => {
    const u = await makeUser("late");
    const b = await ingestBankMovement(env.DB, u.id, bank({ account_id: u.accountId, amount_cents: 2000, fecha: "2026-11-20" }));
    const typed = await json(call("POST", "/api/movements", { client_id: "typed-late-001", amount_cents: 2000, account_id: u.accountId, fecha: "2026-11-21", category_id: u.cats["Supermercado"] }, u.cookie));
    expect(typed.possible_duplicates.map((x: { id: number }) => x.id)).toEqual([(b as { id: number }).id]);
    const merged = await json(call("POST", `/api/movements/${typed.movement.id}/merge`, { bank_id: (b as { id: number }).id }, u.cookie));
    expect(merged.movement.category_id).toBe(u.cats["Supermercado"]);
    expect((await json(call("GET", "/api/movements", undefined, u.cookie))).items).toHaveLength(1);
  });
});

describe("review inbox and shop memory", () => {
  it("one tap sorts the waiting rows from the same shop and the next one arrives sorted", async () => {
    const u = await makeUser("rev");
    for (const f of ["2026-11-01", "2026-11-02"]) {
      await ingestBankMovement(env.DB, u.id, bank({ account_id: u.accountId, amount_cents: 777, fecha: f, comercio: `TIENDA NUEVA 00${f.slice(-1)}9` }));
    }
    const rev = await json(call("GET", "/api/review", undefined, u.cookie));
    expect(rev.items).toHaveLength(2);
    const r = await json(call("POST", `/api/review/${rev.items[0].id}/categorize`, { category_id: u.cats["Supermercado"] }, u.cookie));
    expect(r.also_updated).toBe(1);
    expect((await json(call("GET", "/api/review", undefined, u.cookie))).items).toHaveLength(0);
    const next = await ingestBankMovement(env.DB, u.id, bank({ account_id: u.accountId, amount_cents: 100, fecha: "2026-11-05", comercio: "Tienda Nueva 0042" }));
    const row = await json(call("GET", `/api/movements/${(next as { id: number }).id}`, undefined, u.cookie));
    expect(row.movement.category_id).toBe(u.cats["Supermercado"]);
    expect(row.movement.estado).toBe("ok");
  });

  it("keeps declined and unclear rows instead of dropping them", async () => {
    const u = await makeUser("keep");
    await ingestBankMovement(env.DB, u.id, bank({ account_id: u.accountId, amount_cents: 5000, fecha: "2026-11-03", tipo: "rechazado" }));
    await ingestBankMovement(env.DB, u.id, bank({ account_id: u.accountId, amount_cents: 6000, fecha: "2026-11-03", comercio: "???" }));
    const all = await json(call("GET", "/api/movements", undefined, u.cookie));
    expect(all.items).toHaveLength(2);
    const s = await json(call("GET", "/api/summary?month=2026-11", undefined, u.cookie));
    expect(s.spent_cents).toBe(6000); // declined does not count
    expect(s.uncategorized_cents).toBe(6000);
  });
});

describe("summary", () => {
  it("counts expenses minus refunds, ignores internal moves, and compares with limits", async () => {
    const u = await makeUser("sum");
    const add = (cid: string, cents: number, tipo: string, cat?: number) =>
      call("POST", "/api/movements", { client_id: cid, amount_cents: cents, account_id: u.accountId, tipo, category_id: cat ?? null, fecha: "2026-10-15" }, u.cookie);
    await add("sum-test-0001", 10000, "gasto", u.cats["Supermercado"]);
    await add("sum-test-0002", 2500, "abono", u.cats["Supermercado"]);
    await add("sum-test-0003", 99999, "interno");
    await add("sum-test-0004", 260000, "ingreso");
    const s = await json(call("GET", "/api/summary?month=2026-10", undefined, u.cookie));
    expect(s.spent_cents).toBe(7500);
    expect(s.income_cents).toBe(260000);
    expect(s.limit_cents).toBe(50000);
    expect(s.day).toBe(31); // a past month counts as complete
    const g = s.groups.find((x: { name: string }) => x.name === "Comida");
    expect(g.spent_cents).toBe(7500);
    expect(s.by_kind.E).toBe(7500);
  });
});

describe("csv export", () => {
  it("cannot smuggle spreadsheet formulas", async () => {
    const u = await makeUser("csv");
    await call("POST", "/api/movements", { client_id: "csv-test-0001", amount_cents: 100, account_id: u.accountId, comercio: '=HYPERLINK("x")' }, u.cookie);
    const csv = await (await call("GET", "/api/export.csv", undefined, u.cookie)).text();
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
  });
});
