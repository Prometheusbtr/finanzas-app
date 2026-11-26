// Security tests (Seguridad). One block per finding; see SECURITY.md for the list.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import app, * as entry from "../src/index.ts";
import { API_HEADERS, MAX_BODY_BYTES } from "../src/lib/security.ts";
import { ipBucket, ipKey, LOCK_MS, MAX_SESSION_MS, nameKey, SESSION_COOKIE, sha256Hex } from "../src/lib/auth.ts";
import { shiftDays, svNow } from "../src/lib/dates.ts";
import { ingestBankMovement } from "../src/lib/merge.ts";
import { cleanText } from "../src/lib/text.ts";
import { maskDigits as serverMask } from "../src/lib/importing.ts";
import { maskDigits as phoneMask } from "../public/import/parse.js";
import { call, cookieOf, ipFor, json, login, makeUser, PASS, type TestUser } from "./helpers.ts";

const DAY = 24 * 60 * 60 * 1000;
const db = () => env.DB;
const tokenOf = (cookie: string) => cookie.slice(cookie.indexOf("=") + 1);
const sessionCount = async (userId: number) =>
  (await db().prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?").bind(userId).first<{ n: number }>())!.n;
const counts = (statuses: number[]) => statuses.reduce<Record<number, number>>((m, s) => ((m[s] = (m[s] ?? 0) + 1), m), {});
const isOk = async (u: TestUser) => (await call("GET", "/api/bootstrap", undefined, u.cookie)).status === 200;

function expectSecurityHeaders(res: Response, what: string) {
  for (const [k, v] of Object.entries(API_HEADERS)) expect(res.headers.get(k), `${what}: ${k}`).toBe(v);
}

async function makeOwner(prefix = "own") {
  const u = await makeUser(prefix);
  await db().prepare("UPDATE users SET is_owner = 1 WHERE id = ?").bind(u.id).run();
  return u;
}

async function movement(u: TestUser, extra: Record<string, unknown> = {}) {
  const res = await call("POST", "/api/movements", {
    client_id: `sec-${Math.random().toString(36).slice(2, 12)}`, amount_cents: 1234, account_id: u.accountId, ...extra,
  }, u.cookie);
  expect(res.status).toBe(201);
  return (await json(res)).movement as { id: number; comercio: string; nota: string; tags: string[]; fecha: string };
}

describe("security headers on every API response, errors included", () => {
  it("sends the same headers on 200, 201, 400, 401, 403, 404, 413, 415, 429 and 500", async () => {
    const u = await makeUser("hdr");
    const big = JSON.stringify({ x: "a".repeat(MAX_BODY_BYTES) });
    const cases: [string, Response][] = [
      ["200 bootstrap", await call("GET", "/api/bootstrap", undefined, u.cookie)],
      ["200 csv", await call("GET", "/api/export.csv", undefined, u.cookie)],
      ["201 create", await call("POST", "/api/movements", { client_id: "hdr-0000001", amount_cents: 5, account_id: u.accountId }, u.cookie)],
      ["200 login", await login(u.username, PASS)],
      ["401 login", await login(u.username, "wrong-pass")],
      ["400 bad json", await call("POST", "/api/movements", undefined, u.cookie, { "content-type": "application/json" })],
      ["400 invalid", await call("POST", "/api/movements", { amount_cents: -1 }, u.cookie)],
      ["401 no session", await call("GET", "/api/bootstrap")],
      ["403 origin", await call("POST", "/api/logout", {}, u.cookie, { origin: "https://evil.example" })],
      ["403 cross-site", await call("GET", "/api/bootstrap", undefined, u.cookie, { "sec-fetch-site": "cross-site" })],
      ["404", await call("GET", "/api/nothing-here", undefined, u.cookie)],
      ["404 id", await call("GET", "/api/movements/999999999", undefined, u.cookie)],
      ["413", await app.request("https://finanzas.test/api/movements", { method: "POST", headers: { "content-type": "application/json", cookie: u.cookie }, body: big }, env)],
      ["415", await call("POST", "/api/movements", "x", u.cookie, { "content-type": "text/plain" })],
    ];
    for (let i = 0; i < 5; i++) await login("hdr-locked", "wrong", "198.51.100.40");
    cases.push(["429", await login("hdr-locked", "wrong", "198.51.100.40")]);
    // A database that fails: the 500 still carries the headers and says nothing about the cause.
    const broken = { ...env, DB: { prepare() { throw new Error("db down"); } } };
    const r500 = await app.request("https://finanzas.test/api/bootstrap", { headers: { cookie: u.cookie } }, broken as unknown as Env);
    cases.push(["500", r500]);
    const want = [200, 200, 201, 200, 401, 400, 400, 401, 403, 403, 404, 404, 413, 415, 429, 500];
    expect(cases.map(([, r]) => r.status)).toEqual(want);
    for (const [what, r] of cases) expectSecurityHeaders(r, what);
    expect(await r500.json()).toEqual({ error: "server" });
  });
});

describe("session cookie", () => {
  it("is exactly __Host-fz_s; HttpOnly; Secure; SameSite=Strict; Path=/ with no Domain, over https", async () => {
    const u = await makeUser("ck");
    const res = await login(u.username, PASS);
    const sc = res.headers.get("set-cookie")!;
    expect(sc).toMatch(/^__Host-fz_s=[A-Za-z0-9_-]{43}; Max-Age=7776000; Path=\/; HttpOnly; Secure; SameSite=Strict$/);
    expect(sc).not.toMatch(/domain/i);
    const out = await call("POST", "/api/logout", {}, cookieOf(res));
    expect(out.headers.get("set-cookie")).toMatch(/^__Host-fz_s=; Max-Age=0; Path=\/; HttpOnly; Secure; SameSite=Strict$/);
  });

  it("ignores a plain fz_s cookie over https (no downgrade)", async () => {
    const u = await makeUser("ck2");
    expect((await call("GET", "/api/bootstrap", undefined, `fz_s=${tokenOf(u.cookie)}`)).status).toBe(401);
  });

  it("local dev on http://127.0.0.1 and http://localhost uses plain fz_s without Secure, still Strict", async () => {
    const u = await makeUser("ck3");
    for (const base of ["http://127.0.0.1:8788", "http://localhost:8788"]) {
      const res = await call("POST", `${base}/api/login`, { username: u.username, passphrase: PASS }, undefined, { "cf-connecting-ip": ipFor(u.username) });
      expect(res.status).toBe(200);
      const sc = res.headers.get("set-cookie")!;
      expect(sc).toMatch(/^fz_s=[A-Za-z0-9_-]{43}; Max-Age=7776000; Path=\/; HttpOnly; SameSite=Strict$/);
      expect((await call("GET", `${base}/api/bootstrap`, undefined, cookieOf(res, "fz_s"))).status).toBe(200);
    }
  });

  it("any other http address gets the Secure __Host- cookie (the browser will not keep it)", async () => {
    const u = await makeUser("ck4");
    const res = await call("POST", "http://finanzas.example/api/login", { username: u.username, passphrase: PASS }, undefined, { "cf-connecting-ip": ipFor(u.username) });
    expect(res.headers.get("set-cookie")).toMatch(/^__Host-fz_s=.*; Secure; SameSite=Strict$/);
  });
});

describe("requests from other sites", () => {
  it("refuses writes unless the browser says same-origin, and reads sent by another site", async () => {
    const u = await makeUser("xs");
    const body = { client_id: "xsite-000001", amount_cents: 100, account_id: u.accountId };
    const post = (h: Record<string, string>) => call("POST", "/api/movements", body, u.cookie, h);
    expect((await post({ "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await post({ "sec-fetch-site": "same-site" })).status).toBe(403);
    expect((await post({ "sec-fetch-site": "none" })).status).toBe(403);
    expect((await post({ origin: "https://finanzas.test.evil.example" })).status).toBe(403);
    expect((await post({ origin: "null" })).status).toBe(403);
    expect((await call("POST", "/api/movements", body, u.cookie, { "content-type": "text/plain" })).status).toBe(415);
    expect((await call("POST", "/api/movements", body, u.cookie, { "content-type": "application/x-www-form-urlencoded" })).status).toBe(415);
    expect((await call("POST", "/api/movements", body, u.cookie, { "content-type": "multipart/form-data; boundary=x" })).status).toBe(415);
    expect((await call("GET", "/api/movements", undefined, u.cookie)).status).toBe(200);
    // Nothing above was saved.
    expect((await json(call("GET", "/api/movements", undefined, u.cookie))).items).toHaveLength(0);
    expect((await post({ "sec-fetch-site": "same-origin", origin: "https://finanzas.test" })).status).toBe(201);

    for (const site of ["cross-site", "same-site"]) {
      expect((await call("GET", "/api/export.csv", undefined, u.cookie, { "sec-fetch-site": site })).status).toBe(403);
      expect((await call("GET", "/api/bootstrap", undefined, u.cookie, { "sec-fetch-site": site })).status).toBe(403);
    }
    expect((await call("GET", "/api/export.csv", undefined, u.cookie, { "sec-fetch-site": "none" })).status).toBe(200);
    expect((await call("GET", "/api/export.csv", undefined, u.cookie, { "sec-fetch-site": "same-origin" })).status).toBe(200);
    // Login and logout follow the same rules.
    expect((await call("POST", "/api/login", { username: u.username, passphrase: PASS }, undefined, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await call("POST", "/api/logout", {}, u.cookie, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect(await isOk(u)).toBe(true);
  });
});

describe("M1: login lockout and rate limit", () => {
  it("someone else cannot lock a user out: the lock is per username plus IP", async () => {
    const u = await makeUser("m1a");
    for (let i = 0; i < 5; i++) await login(u.username, "wrong-pass", "203.0.113.66");
    expect((await login(u.username, PASS, "203.0.113.66")).status).toBe(429);
    expect((await login(u.username, PASS, ipFor(u.username))).status).toBe(200);
  });

  it("tries sent at the same moment are counted before checking: 9 at once give 4 wrong answers and 5 locks", async () => {
    const u = await makeUser("m1b");
    const ip = "203.0.113.9";
    const res = await Promise.all(Array.from({ length: 9 }, () => login(u.username, "wrong-pass", ip)));
    expect(counts(res.map((r) => r.status))).toEqual({ 401: 4, 429: 5 });
    expect((await login(u.username, PASS, ip)).status).toBe(429);
  });

  it("a burst of 40 at once from one IP gets at most 10 through to the check, and at most 4 wrong answers", async () => {
    const u = await makeUser("m1c");
    const ip = "203.0.113.40";
    const res = await Promise.all(Array.from({ length: 40 }, () => login(u.username, "wrong-pass", ip)));
    const byStatus = counts(res.map((r) => r.status));
    expect(byStatus[401]).toBe(4);
    expect(byStatus[429]).toBe(36);
    const bodies = await Promise.all(res.filter((r) => r.status === 429).map((r) => r.json() as Promise<{ error: string }>));
    expect(bodies.filter((b) => b.error === "slow_down").length).toBe(30);
  });

  it("allows 10 login tries a minute per IP across usernames, then says slow down", async () => {
    const ip = "203.0.113.10";
    for (let i = 0; i < 10; i++) expect((await login(`nobody-${i}`, "wrong-pass", ip)).status).toBe(401);
    const r = await login("nobody-x", "wrong-pass", ip);
    expect(r.status).toBe(429);
    expect(await r.json()).toMatchObject({ error: "slow_down" });
    expect(Number(r.headers.get("retry-after"))).toBeLessThanOrEqual(60);
    // Another IP is not affected.
    expect((await login("nobody-x", "wrong-pass", "203.0.113.11")).status).toBe(401);
    // A minute later the IP may try again.
    await db().prepare("UPDATE login_limits SET window_start = window_start - 61000 WHERE k = ?").bind(await ipKey(ip)).run();
    expect((await login("nobody-y", "wrong-pass", ip)).status).toBe(401);
  });

  it("one IPv6 home (/64) counts as one IP", async () => {
    expect(ipBucket("2001:db8:1:2:aaaa::1")).toBe(ipBucket("2001:0db8:0001:0002:ffff:ffff:ffff:ffff"));
    expect(ipBucket("2001:db8:1:2::")).toBe("2001:db8:1:2::/64");
    expect(ipBucket("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(ipBucket("2001:db8:1:3::1")).not.toBe(ipBucket("2001:db8:1:2::1"));
    expect(ipBucket("::ffff:198.51.100.7")).toBe("198.51.100.7");
    expect(ipBucket(undefined)).toBe("unknown");
    for (let i = 0; i < 10; i++) await login(`six-${i}`, "wrong-pass", `2001:db8:77:1::${i.toString(16)}`);
    expect((await login("six-x", "wrong-pass", "2001:db8:77:1:dead:beef:0:1")).status).toBe(429);
  });

  it("stores no IP address or username in the counters, and cleans old rows", async () => {
    const ip = "198.51.100.23";
    await login("findme-user", "wrong-pass", ip);
    const { results } = await db().prepare("SELECT k FROM login_limits").all<{ k: string }>();
    expect(results.length).toBeGreaterThan(0);
    for (const { k } of results) {
      expect(k).toMatch(/^(ip|name):[0-9a-f]{64}$/);
      expect(k).not.toContain(ip);
      expect(k).not.toContain("findme");
    }
    const old = "name:" + "0".repeat(64);
    await db().prepare("INSERT INTO login_limits (k, tries, window_start) VALUES (?, 3, ?)").bind(old, Date.now() - LOCK_MS - 1000).run();
    await login("someone", "wrong-pass", "198.51.100.24");
    expect(await db().prepare("SELECT 1 FROM login_limits WHERE k = ?").bind(old).first()).toBeNull();
  });

  it("a right passphrase clears only this username's counter", async () => {
    const u = await makeUser("m1d");
    const ip = "198.51.100.30";
    await login(u.username, "wrong-pass", ip);
    expect((await login(u.username, PASS, ip)).status).toBe(200);
    expect(await db().prepare("SELECT 1 FROM login_limits WHERE k = ?").bind(await nameKey(u.username, ip)).first()).toBeNull();
    expect(await db().prepare("SELECT 1 FROM login_limits WHERE k = ?").bind(await ipKey(ip)).first()).not.toBeNull();
  });
});

describe("M2: sessions end", () => {
  it("after 180 days at most, even when used every day", async () => {
    const u = await makeUser("m2a");
    const th = await sha256Hex(tokenOf(u.cookie));
    const now = Date.now();
    // Made 150 days ago, 10 days left: renewal stops at day 180, not 90 days from now.
    await db().prepare("UPDATE sessions SET created_at = ?, expires_at = ? WHERE token_hash = ?").bind(now - 150 * DAY, now + 10 * DAY, th).run();
    const r = await call("GET", "/api/bootstrap", undefined, u.cookie);
    expect(r.status).toBe(200);
    const row = await db().prepare("SELECT created_at, expires_at FROM sessions WHERE token_hash = ?").bind(th).first<{ created_at: number; expires_at: number }>();
    expect(row!.expires_at).toBe(row!.created_at + MAX_SESSION_MS);
    const maxAge = Number(/Max-Age=(\d+)/.exec(r.headers.get("set-cookie") ?? "")?.[1]);
    expect(maxAge).toBeGreaterThan(29 * 86400);
    expect(maxAge).toBeLessThanOrEqual(30 * 86400);
    // Past 180 days it is refused, whatever expires_at says.
    await db().prepare("UPDATE sessions SET created_at = ?, expires_at = ? WHERE token_hash = ?").bind(now - MAX_SESSION_MS - 1000, now + 10 * DAY, th).run();
    const gone = await call("GET", "/api/bootstrap", undefined, u.cookie);
    expect(gone.status).toBe(401);
    expect(gone.headers.get("set-cookie")).toMatch(/^__Host-fz_s=; Max-Age=0;/);
  });

  it("everywhere at once with sign out everywhere, and only for that user", async () => {
    const u = await makeUser("m2b");
    const other = await makeUser("m2b-other");
    const second = cookieOf(await login(u.username, PASS));
    expect(await sessionCount(u.id)).toBe(2);
    const r = await call("POST", "/api/logout-all", {}, second);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, ended: 2 });
    expect(await isOk(u)).toBe(false);
    expect((await call("GET", "/api/bootstrap", undefined, second)).status).toBe(401);
    expect(await isOk(other)).toBe(true);
  });

  it("when the passphrase (a login method) changes, by any path", async () => {
    const u = await makeUser("m2c");
    await login(u.username, PASS);
    await db().prepare("UPDATE users SET lang = 'en' WHERE id = ?").bind(u.id).run();
    expect(await isOk(u)).toBe(true); // other changes keep sessions
    await db().prepare("UPDATE users SET pass_hash = ? WHERE id = ?").bind("f".repeat(64), u.id).run();
    expect(await sessionCount(u.id)).toBe(0);
    expect(await isOk(u)).toBe(false);
  });

  it("when the owner ends them; nobody else can", async () => {
    const owner = await makeOwner();
    const a = await makeUser("m2d");
    const b = await makeUser("m2e");
    expect((await json(call("GET", "/api/bootstrap", undefined, owner.cookie))).user.is_owner).toBe(true);
    expect((await json(call("GET", "/api/bootstrap", undefined, a.cookie))).user.is_owner).toBe(false);

    expect((await call("GET", "/api/users", undefined, a.cookie)).status).toBe(403);
    expect((await call("POST", `/api/users/${b.id}/logout-all`, {}, a.cookie)).status).toBe(403);
    expect(await isOk(b)).toBe(true);

    const list = await json(call("GET", "/api/users", undefined, owner.cookie));
    const row = list.users.find((x: { id: number }) => x.id === a.id);
    expect(row).toMatchObject({ username: a.username, sessions: 1, is_owner: false });
    expect(Object.keys(row).sort()).toEqual(["display_name", "id", "is_owner", "sessions", "username"]);

    const r = await call("POST", `/api/users/${a.id}/logout-all`, {}, owner.cookie);
    expect(await r.json()).toEqual({ ok: true, ended: 1 });
    expect(await isOk(a)).toBe(false);
    expect(await isOk(b)).toBe(true);
    expect(await isOk(owner)).toBe(true);
    expect((await call("POST", "/api/users/999999999/logout-all", {}, owner.cookie)).status).toBe(404);
    expect((await call("POST", "/api/users/abc/logout-all", {}, owner.cookie)).status).toBe(404);
  });
});

describe("cross-user matrix: every route that takes an id", () => {
  it("B gets nothing from A's ids and A's data stays the same", async () => {
    const a = await makeUser("mx-a");
    const b = await makeUser("mx-b");
    const g = (u: TestUser) => db().prepare("SELECT id FROM groups WHERE user_id = ?").bind(u.id).first<{ id: number }>().then((r) => r!.id);
    const gA = await g(a);
    const mA = await movement(a, { comercio: "TIENDA A", category_id: null });
    const mB = await movement(b, { comercio: "TIENDA B" });
    // A suggestion that belongs to A.
    for (const f of ["2026-11-19", "2026-11-21"]) await movement(a, { amount_cents: 777, fecha: f });
    await ingestBankMovement(db(), a.id, { account_id: a.accountId, amount_cents: 777, fecha: "2026-11-20", hora: "12:00", tipo: "gasto", comercio: "X", origen: "correo BAC", raw: "r", dedupe_key: "bac:mx:1" });
    const sA = (await json(call("GET", "/api/review", undefined, a.cookie))).suggestions[0].id as number;

    const snapshot = async () => {
      const t = ["movements", "groups", "categories", "accounts", "merchant_rules", "merge_suggestions"];
      const out: Record<string, unknown> = {};
      for (const name of t) out[name] = (await db().prepare(`SELECT * FROM ${name} WHERE user_id = ? ORDER BY 1`).bind(a.id).all()).results;
      return JSON.stringify(out);
    };
    const before = await snapshot();

    const tries: [string, string, unknown?][] = [
      ["GET", `/api/movements/${mA.id}`],
      ["PUT", `/api/movements/${mA.id}`, { nota: "x" }],
      ["DELETE", `/api/movements/${mA.id}`, {}],
      ["POST", `/api/movements/${mA.id}/merge`, { bank_id: mB.id }],
      ["POST", `/api/movements/${mB.id}/merge`, { bank_id: mA.id }],
      ["POST", `/api/review/${mA.id}/categorize`, { category_id: b.cats["Supermercado"] }],
      ["POST", `/api/review/${mB.id}/categorize`, { category_id: a.cats["Supermercado"] }],
      ["POST", `/api/suggestions/${sA}/accept`, {}],
      ["POST", `/api/suggestions/${sA}/reject`, {}],
      ["PUT", `/api/groups/${gA}`, { name: "x" }],
      ["PUT", `/api/categories/${a.cats["Supermercado"]}`, { name: "x" }],
      ["PUT", `/api/categories/${b.cats["Supermercado"]}`, { group_id: gA }],
      ["PUT", `/api/accounts/${a.accountId}`, { name: "x" }],
      ["POST", "/api/categories", { group_id: gA, name: "robada", kind: "G" }],
      ["POST", "/api/movements", { client_id: "mx-0000001", amount_cents: 1, account_id: a.accountId }],
      ["POST", "/api/movements", { client_id: "mx-0000002", amount_cents: 1, account_id: b.accountId, category_id: a.cats["Supermercado"] }],
      ["PUT", `/api/movements/${mB.id}`, { account_id: a.accountId }],
      ["PUT", `/api/movements/${mB.id}`, { category_id: a.cats["Restaurantes"] }],
      ["POST", `/api/users/${a.id}/logout-all`, {}],
    ];
    for (const [method, path, body] of tries) {
      const r = await call(method, path, body, b.cookie);
      expect([400, 403, 404], `${method} ${path}`).toContain(r.status);
    }
    for (const q of [`account_id=${a.accountId}`, `category_id=${a.cats["Supermercado"]}`, `group_id=${gA}`]) {
      expect((await json(call("GET", `/api/movements?${q}`, undefined, b.cookie))).items, q).toHaveLength(0);
    }
    expect(await snapshot()).toBe(before);
    expect(await isOk(a)).toBe(true);
  });
});

describe("the database refuses links across users (migration 0002)", () => {
  it("even when the app's own checks are skipped", async () => {
    const a = await makeUser("db-a");
    const b = await makeUser("db-b");
    const gA = (await db().prepare("SELECT id FROM groups WHERE user_id = ?").bind(a.id).first<{ id: number }>())!.id;
    const mA = await movement(a);
    const mB = await movement(b);
    const now = Date.now();
    const bad = [
      db().prepare("INSERT INTO categories (user_id, group_id, name, kind) VALUES (?, ?, 'x', 'G')").bind(b.id, gA),
      db().prepare("UPDATE categories SET group_id = ? WHERE id = ?").bind(gA, b.cats["Supermercado"]),
      db().prepare("INSERT INTO movements (user_id, fecha, amount_cents, tipo, account_id, origen, dedupe_key, created_at, updated_at) VALUES (?, '2026-11-01', 1, 'gasto', ?, 'manual', 'db-x1', ?, ?)").bind(b.id, a.accountId, now, now),
      db().prepare("INSERT INTO movements (user_id, fecha, amount_cents, tipo, category_id, origen, dedupe_key, created_at, updated_at) VALUES (?, '2026-11-01', 1, 'gasto', ?, 'manual', 'db-x2', ?, ?)").bind(b.id, a.cats["Supermercado"], now, now),
      db().prepare("UPDATE movements SET account_id = ? WHERE id = ?").bind(a.accountId, mB.id),
      db().prepare("UPDATE movements SET category_id = ? WHERE id = ?").bind(a.cats["Restaurantes"], mB.id),
      db().prepare("INSERT INTO merchant_rules (user_id, merchant_key, category_id, updated_at) VALUES (?, 'k', ?, ?)").bind(b.id, a.cats["Supermercado"], now),
      db().prepare("INSERT INTO merge_suggestions (user_id, bank_id, manual_id, created_at) VALUES (?, ?, ?, ?)").bind(b.id, mA.id, mB.id, now),
      db().prepare("INSERT INTO merge_suggestions (user_id, bank_id, manual_id, created_at) VALUES (?, ?, ?, ?)").bind(b.id, mB.id, mA.id, now),
      db().prepare("UPDATE movements SET user_id = ? WHERE id = ?").bind(b.id, mA.id),
      db().prepare("UPDATE accounts SET user_id = ? WHERE id = ?").bind(b.id, a.accountId),
      db().prepare("UPDATE groups SET user_id = ? WHERE id = ?").bind(b.id, gA),
      db().prepare("UPDATE categories SET user_id = ? WHERE id = ?").bind(b.id, a.cats["Supermercado"]),
      db().prepare("UPDATE sessions SET user_id = ? WHERE user_id = ?").bind(a.id, b.id),
    ];
    for (const [i, stmt] of bad.entries()) {
      await expect(stmt.run(), `statement ${i}`).rejects.toThrow(/cross_user|user_id_fixed/);
    }
    // Same-user links still work, including the merchant rule upsert.
    await db().prepare("INSERT INTO merchant_rules (user_id, merchant_key, category_id, updated_at) VALUES (?, 'k', ?, ?)").bind(b.id, b.cats["Supermercado"], now).run();
    await expect(db().prepare(
      "INSERT INTO merchant_rules (user_id, merchant_key, category_id, updated_at) VALUES (?, 'k', ?, ?) ON CONFLICT (user_id, merchant_key) DO UPDATE SET category_id = excluded.category_id",
    ).bind(b.id, a.cats["Supermercado"], now).run()).rejects.toThrow(/cross_user/);
    expect(await isOk(b)).toBe(true);
  });

  it("review.ts only looks at the user's own merge suggestions", async () => {
    // Make the bad row possible again for one moment, as an older database could hold it.
    const trig = await db().prepare("SELECT sql FROM sqlite_master WHERE name = 'merge_suggestions_same_user_ins'").first<{ sql: string }>();
    const a = await makeUser("rv-a");
    const b = await makeUser("rv-b");
    const mA = await movement(a, { category_id: null, comercio: "SIN CATEGORIA" });
    const mB = await movement(b);
    expect((await json(call("GET", "/api/review", undefined, a.cookie))).items).toHaveLength(1);
    await db().prepare("DROP TRIGGER merge_suggestions_same_user_ins").run();
    try {
      await db().prepare("INSERT INTO merge_suggestions (user_id, bank_id, manual_id, created_at) VALUES (?, ?, ?, ?)").bind(b.id, mA.id, mB.id, Date.now()).run();
      // B's stray row must not hide A's waiting row from A.
      expect((await json(call("GET", "/api/review", undefined, a.cookie))).items).toHaveLength(1);
    } finally {
      await db().prepare("DELETE FROM merge_suggestions WHERE user_id = ? AND bank_id = ?").bind(b.id, mA.id).run();
      await db().prepare(trig!.sql).run();
    }
  });
});

describe("size and range limits", () => {
  it("refuses bodies over 64 KB, with or without a length header", async () => {
    const u = await makeUser("sz");
    const big = JSON.stringify({ client_id: "size-000001", amount_cents: 1, account_id: u.accountId, nota: "a".repeat(MAX_BODY_BYTES) });
    const withLength = await app.request("https://finanzas.test/api/movements", { method: "POST", headers: { "content-type": "application/json", cookie: u.cookie }, body: big }, env);
    expect(withLength.status).toBe(413);
    const bytes = new TextEncoder().encode(big);
    const stream = new ReadableStream({ start(ctl) { for (let i = 0; i < bytes.length; i += 8192) ctl.enqueue(bytes.slice(i, i + 8192)); ctl.close(); } });
    const chunked = await app.request("https://finanzas.test/api/movements", { method: "POST", headers: { "content-type": "application/json", cookie: u.cookie }, body: stream }, env);
    expect(chunked.status).toBe(413);
    const loginBig = await call("POST", "/api/login", { username: "x", passphrase: "y".repeat(MAX_BODY_BYTES) });
    expect(loginBig.status).toBe(413);
    expect((await json(call("GET", "/api/movements", undefined, u.cookie))).items).toHaveLength(0);
  });

  it("accepts dates from 2000-01-01 to tomorrow only", async () => {
    const u = await makeUser("dt");
    const today = svNow().fecha;
    const post = (fecha: string) => call("POST", "/api/movements", { client_id: `dt-${fecha}-${Math.random().toString(36).slice(2, 6)}`, amount_cents: 1, account_id: u.accountId, fecha }, u.cookie);
    expect((await post("1999-12-31")).status).toBe(400);
    expect((await post("2000-01-01")).status).toBe(201);
    expect((await post(today)).status).toBe(201);
    expect((await post(shiftDays(today, 1))).status).toBe(201);
    expect((await post(shiftDays(today, 2))).status).toBe(400);
    expect((await post("9999-12-31")).status).toBe(400);
    expect((await post("2026-02-30")).status).toBe(400);
    const m = await movement(u);
    expect((await call("PUT", `/api/movements/${m.id}`, { fecha: shiftDays(today, 2) }, u.cookie)).status).toBe(400);
    expect((await call("PUT", `/api/movements/${m.id}`, { fecha: "1900-01-01" }, u.cookie)).status).toBe(400);
  });

  it("keeps paging numbers in range", async () => {
    const u = await makeUser("pg");
    await movement(u);
    for (const q of ["offset=1e15", "offset=99999999999", "offset=-5", "offset=abc", "limit=2.5", "limit=-1", "limit=1e9", "offset=1.5"]) {
      const r = await call("GET", `/api/movements?${q}`, undefined, u.cookie);
      expect(r.status, q).toBe(200);
    }
    expect((await json(call("GET", "/api/movements?offset=-5", undefined, u.cookie))).items).toHaveLength(1);
    expect((await json(call("GET", "/api/movements?offset=1e15", undefined, u.cookie))).items).toHaveLength(0);
  });
});

describe("invisible direction characters", () => {
  it("are removed from every text the browser sends", async () => {
    const u = await makeUser("bidi");
    const evil = "PAGO‮⁦ ABC​⁩‬﻿\u0000";
    const m = await movement(u, { comercio: evil, nota: `nota‏${evil}`, tags: [`viaje‭x`] });
    expect(m.comercio).toBe("PAGO ABC");
    expect(m.nota).toBe("notaPAGO ABC");
    expect(m.tags).toEqual(["viajex"]);
    const acc = await json(call("POST", "/api/accounts", { name: "Cuenta‮⁧X" }, u.cookie));
    const row = await db().prepare("SELECT name FROM accounts WHERE id = ?").bind(acc.id).first<{ name: string }>();
    expect(row!.name).toBe("CuentaX");
    // Emoji joiners stay.
    expect(cleanText("👩‍💻 café")).toBe("👩‍💻 café");
  });

  it("are removed from shop names that arrive from bank emails", async () => {
    const u = await makeUser("bidi2");
    const r = await ingestBankMovement(db(), u.id, { account_id: u.accountId, amount_cents: 50, fecha: "2026-11-20", hora: "10:00", tipo: "gasto", comercio: "SHOP‮txt.exe", origen: "correo BAC", raw: "r", dedupe_key: "bac:bidi:1" });
    const row = await db().prepare("SELECT comercio FROM movements WHERE id = ?").bind((r as { id: number }).id).first<{ comercio: string }>();
    expect(row!.comercio).toBe("SHOPtxt.exe");
  });
});

describe("front end text", () => {
  it("t() puts values in exactly as typed, even with $& or $'", async () => {
    (globalThis as { document?: unknown }).document ??= { getElementById: () => null };
    // @ts-ignore plain browser module without types
    const { t } = await import("../public/js/i18n.js");
    expect(t("hello", { name: "$&$'$`$1" })).toBe("Hola, $&$'$`$1");
    expect(t("ofLimit", { x: "$&", limit: "$$" })).toBe("$& de $$ con límite");
  });
});

describe("worker entry", () => {
  it("exports only the app (any other export stops the Worker from starting)", () => {
    expect(Object.keys(entry)).toEqual(["default"]);
    expect(SESSION_COOKIE).toBe("__Host-fz_s");
  });
});

// ---------- Importar review (Nov 25 2026) ----------

type ImpRow = { fecha: string; comercio?: string; cents: number; dir: "out" | "in"; tipo?: "interno" | "ingreso" | null };
const OCT = { period_start: "2026-10-01", period_end: "2026-10-31" };

async function importRows(u: TestUser, rows: ImpRow[], source = "bac_tc", accountId = u.accountId) {
  const s = await call("POST", "/api/imports", { account_id: accountId, source, balanced: true, ...OCT }, u.cookie);
  expect(s.status).toBe(201);
  const id = (await json<{ id: number }>(s)).id;
  expect((await call("POST", `/api/imports/${id}/rows`, { part: 0, rows }, u.cookie)).status).toBe(200);
  const done = await json(call("POST", `/api/imports/${id}/finish`, {}, u.cookie));
  return { id, totals: done.totals as { added: number; already: number; merged: number; review: number } };
}
const allRows = async (u: TestUser) =>
  (await db().prepare("SELECT * FROM movements WHERE user_id = ? ORDER BY id").bind(u.id).all<Record<string, unknown>>()).results;

describe("Importar: money in from a general CSV never lowers spending", () => {
  it("is saved as ingreso waiting in Revisar; a card statement's credit stays a refund", async () => {
    const u = await makeUser("imc");
    const rows: ImpRow[] = [
      { fecha: "2026-10-02", comercio: "SUPER DEMO", cents: 4000, dir: "out" },
      { fecha: "2026-10-15", comercio: "PLANILLA DEMO", cents: 150000, dir: "in" }, // pay, in a bank CSV with no type column
    ];
    const p = await json(call("POST", "/api/imports/preview", { account_id: u.accountId, source: "csv", ...OCT, rows }, u.cookie));
    expect(p).toMatchObject({ added: 2, review: 1 }); // the shop is sorted by a starter rule; the pay waits
    await importRows(u, rows, "csv");
    const pay = (await allRows(u)).find((m) => m.amount_cents === 150000)!;
    expect([pay.tipo, pay.estado]).toEqual(["ingreso", "revisar"]);
    let s = await json(call("GET", "/api/summary?month=2026-10", undefined, u.cookie));
    expect(s.spent_cents).toBe(4000); // before the fix: 4000 - 150000, clamped or negative
    expect(s.income_cents).toBe(150000);
    // The user says it was a refund: only then does it lower spending.
    await call("PUT", `/api/movements/${pay.id}`, { tipo: "abono", amount_cents: 1000 }, u.cookie);
    s = await json(call("GET", "/api/summary?month=2026-10", undefined, u.cookie));
    expect(s.spent_cents).toBe(3000);

    const v = await makeUser("imc");
    await importRows(v, [{ fecha: "2026-10-04", comercio: "DEVOLUCION DEMO", cents: 500, dir: "in" }], "bac_tc");
    expect((await allRows(v))[0].tipo).toBe("abono");
  });
});

describe("Importar: the server masks long digit runs the phone missed", () => {
  it("keeps only the last 4 of card, account and reference numbers, in the shop name and in raw", async () => {
    const u = await makeUser("imm");
    await importRows(u, [
      { fecha: "2026-10-03", comercio: "PAGO 4000 1234 5678 9010 REF 1234567", cents: 100, dir: "out" },
      { fecha: "2026-10-04", comercio: "AMEX 3782 822463 10005", cents: 200, dir: "out" },
      { fecha: "2026-10-05", comercio: "CTA 200-123456-7 SHOP 0123", cents: 300, dir: "out" },
    ]);
    const got = (await allRows(u)).map((m) => [m.comercio, JSON.parse(m.raw as string).comercio]);
    expect(got).toEqual([
      ["PAGO ••••9010 REF ••••4567", "PAGO ••••9010 REF ••••4567"],
      ["AMEX ••••0005", "AMEX ••••0005"],
      ["CTA ••••4567 SHOP 0123", "CTA ••••4567 SHOP 0123"],
    ]);
  });
});

describe("Importar: phone and server mask digits the same way", () => {
  it("gives the same text for card, account, reference and short numbers", () => {
    const samples = [
      "PAGO 4000 1234 5678 9010", "4000-1234-5678-9010", "REF 123456789", "AMEX 3782 822463 10005", "CTA 200-123456-7",
      "SHOP 0123", "TEL 2222 3333", "1,234.56", "2026-10-05", "••••5678", "NIT 0614-120390-101-2", "",
    ];
    for (const x of samples) expect(serverMask(x), x).toBe(phoneMask(x));
    expect(phoneMask("AMEX 3782 822463 10005")).toBe("AMEX ••••0005");
    expect(phoneMask("TEL 2222 3333")).toBe("TEL 2222 3333");
  });
});

describe("Importar: undo puts back exactly what the import took", () => {
  it("brings back a typed row merged into an imported row later, in Revisar or from the add screen", async () => {
    const u = await makeUser("imu");
    const now = Date.now();
    const typed = async (fecha: string, cents: number, nota: string) =>
      (await db().prepare(
        `INSERT INTO movements (user_id, fecha, amount_cents, tipo, comercio, merchant_key, account_id, category_id, nota, origen, estado,
           dedupe_key, created_at, updated_at) VALUES (?, ?, ?, 'gasto', 'typed', 'typed', ?, ?, ?, 'manual', 'ok', ?, ?, ?) RETURNING id`,
      ).bind(u.id, fecha, cents, u.accountId, u.cats["Supermercado"], nota, `manual:${Math.random()}`, now, now).first<{ id: number }>())!.id;
    await typed("2026-10-05", 700, "first");
    await typed("2026-10-06", 700, "second");
    const before = await allRows(u);
    const { id } = await importRows(u, [
      { fecha: "2026-10-05", comercio: "TIENDA DEMO", cents: 700, dir: "out" },
      { fecha: "2026-10-20", comercio: "OTRA DEMO", cents: 900, dir: "out" },
    ]);
    // Revisar: "es la misma compra" for one of the two typed rows.
    const rv = await json(call("GET", "/api/review", undefined, u.cookie));
    expect(rv.suggestions.length).toBe(2);
    expect((await call("POST", `/api/suggestions/${rv.suggestions[0].id}/accept`, {}, u.cookie)).status).toBe(200);
    // The add screen: a purchase typed after the import, then "es la misma" with the other imported row.
    const late = await movement(u, { amount_cents: 900, fecha: "2026-10-21", nota: "typed later" });
    const bank = (await allRows(u)).find((m) => m.amount_cents === 900 && m.origen !== "manual")!;
    expect((await call("POST", `/api/movements/${late.id}/merge`, { bank_id: bank.id }, u.cookie)).status).toBe(200);
    const lateRow = { id: late.id, nota: "typed later", origen: "manual" };

    const r = await json(call("POST", `/api/imports/${id}/undo`, {}, u.cookie));
    expect(r).toEqual({ removed: 2, restored: 2, kept: 0 });
    const after = await allRows(u);
    expect(after.filter((m) => m.id !== late.id)).toEqual(before);
    expect(after.find((m) => m.id === late.id)).toMatchObject(lateRow);
  });

  it("brings back a typed row whose id a newer row took meanwhile, under a new id", async () => {
    const u = await makeUser("imu");
    const { id } = await importRows(u, [{ fecha: "2026-10-20", comercio: "OTRA DEMO", cents: 901, dir: "out" }]);
    const bank = (await allRows(u)).find((m) => m.amount_cents === 901)!;
    const late = await movement(u, { amount_cents: 901, fecha: "2026-10-21", nota: "typed later" });
    expect((await call("POST", `/api/movements/${late.id}/merge`, { bank_id: bank.id }, u.cookie)).status).toBe(200);
    const next = await movement(u, { amount_cents: 55, nota: "typed after the merge" });
    expect(next.id).toBe(late.id); // SQLite gives the freed highest id to the next row
    expect(await json(call("POST", `/api/imports/${id}/undo`, {}, u.cookie))).toEqual({ removed: 1, restored: 1, kept: 0 });
    const after = await allRows(u);
    expect(after.map((m) => [m.amount_cents, m.nota, m.id === late.id]).sort()).toEqual([[55, "typed after the merge", true], [901, "typed later", false]]);
  });

  it("brings back columns that later migrations add to movements, not their defaults", async () => {
    await db().prepare("ALTER TABLE movements ADD COLUMN fz_test_later TEXT").run();
    try {
      const u = await makeUser("imu");
      const now = Date.now();
      const t = await db().prepare(
        `INSERT INTO movements (user_id, fecha, amount_cents, tipo, comercio, merchant_key, account_id, origen, estado, dedupe_key,
           created_at, updated_at, fz_test_later) VALUES (?, '2026-10-09', 999, 'gasto', 'typed', 'typed', ?, 'manual', 'revisar', ?, ?, ?, 'COP 40000')
         RETURNING id`,
      ).bind(u.id, u.accountId, `manual:${Math.random()}`, now, now).first<{ id: number }>();
      const before = await allRows(u);
      const { id, totals } = await importRows(u, [{ fecha: "2026-10-08", comercio: "SUPER DEMO", cents: 999, dir: "out" }]);
      expect(totals.merged).toBe(1);
      expect(await json(call("POST", `/api/imports/${id}/undo`, {}, u.cookie))).toEqual({ removed: 1, restored: 1, kept: 0 });
      const after = await allRows(u);
      expect(after).toEqual(before);
      expect(after.find((m) => m.id === t!.id)!.fz_test_later).toBe("COP 40000");
    } finally {
      await db().prepare("ALTER TABLE movements DROP COLUMN fz_test_later").run();
    }
  });

  it("a second import never takes over a row it did not write, so its undo leaves that row alone", async () => {
    const u = await makeUser("imu");
    const rows: ImpRow[] = [
      { fecha: "2026-10-05", comercio: "TIENDA DEMO", cents: 1234, dir: "out" },
      { fecha: "2026-10-06", comercio: "CAFE DEMO", cents: 250, dir: "out" },
    ];
    await importRows(u, rows);
    const moved = (await allRows(u)).find((m) => m.amount_cents === 1234)!;
    // The user moves one imported row to the other account (or another date, or marks it rechazado).
    expect((await call("PUT", `/api/movements/${moved.id}`, { account_id: u.otherAccountId, nota: "kept" }, u.cookie)).status).toBe(200);
    const before = await allRows(u);
    const again = await importRows(u, rows);
    expect(again.totals).toMatchObject({ added: 0, already: 2 });
    expect(await allRows(u)).toEqual(before);
    expect(await json(call("POST", `/api/imports/${again.id}/undo`, {}, u.cookie))).toEqual({ removed: 0, restored: 0, kept: 0 });
    expect(await allRows(u)).toEqual(before);
  });
});

describe("Importar: migration 0004 tables", () => {
  it("deleting a user removes their imports, rows, column maps, fixed payments and savings, and nothing else", async () => {
    const u = await makeUser("imd");
    const keep = await makeUser("imd");
    for (const x of [u, keep]) {
      await importRows(x, [{ fecha: "2026-10-05", comercio: "TIENDA DEMO", cents: 1234, dir: "out" }]);
      const map = { fecha: 0, comercio: 1, monto: 2, cargo: null, abono: null, saldo: null, order: "dmy", sign: "out_negative" };
      expect((await call("PUT", "/api/imports/csv-maps/0123456789abcdef0123456789abcdef", { account_id: x.accountId, map }, x.cookie)).status).toBe(200);
      expect((await call("PUT", "/api/pasos/savings", { amount_cents: 5000 }, x.cookie)).status).toBe(200);
      await db().prepare("INSERT INTO recurring_choices (user_id, merchant_key, keep, amount_cents, every_days, updated_at) VALUES (?, 'x', 1, 1, 30, 0)")
        .bind(x.id).run();
    }
    const tables = ["imports", "import_rows", "import_csv_maps", "recurring_choices", "savings_plan", "movements"];
    const n = async (id: number) => {
      const out: number[] = [];
      for (const t of tables) out.push((await db().prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE user_id = ?`).bind(id).first<{ n: number }>())!.n);
      return out;
    };
    const kept = await n(keep.id);
    expect(kept.every((x) => x > 0)).toBe(true);
    await db().prepare("DELETE FROM users WHERE id = ?").bind(u.id).run();
    expect(await n(u.id)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(await n(keep.id)).toEqual(kept);
  });
});
