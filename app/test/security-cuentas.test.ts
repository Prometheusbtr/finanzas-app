// Seguridad's review of the Cuentas branch (Nov 25 2026): one test per fix, plus the Face ID lock's default deny
// over every route the app has (so routes that Importar and Funciones add later are covered too).
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import app from "../src/index.ts";
import { sha256Hex } from "../src/lib/auth.ts";
import { call, cookieOf, freshProof, json, login, makeUser, type TestUser } from "./helpers.ts";
import { Authenticator, type Opts } from "./webauthn.ts";

const db = () => env.DB;
const OK: Opts = { origin: env.APP_ORIGIN, rpId: env.RP_ID };
const KEY = "ab".repeat(32);
const DAY = 24 * 60 * 60 * 1000;

let ipN = 0;
const freshIp = () => `172.21.${(++ipN >> 8) & 255}.${ipN & 255}`;
const pcall = (method: string, path: string, body?: unknown, cookie?: string, ip = freshIp(), headers: Record<string, string> = {}) =>
  call(method, path, body, cookie, { "cf-connecting-ip": ip, ...headers });
let nameN = 0;
const newName = (p = "sec") => `${p}${++nameN}${Math.random().toString(36).slice(2, 6)}`;
/** Move a reset link's making back past its 24-hour wait. */
const ripen = (inviteId: number) => db().prepare("UPDATE invites SET created_at = created_at - ? WHERE id = ?").bind(DAY + 60_000, inviteId).run();
const alive = async (cookie: string, headers: Record<string, string> = {}) => (await call("GET", "/api/bootstrap", undefined, cookie, headers)).status;

async function makeOwner(): Promise<TestUser> {
  const u = await makeUser("sown");
  await db().prepare("UPDATE users SET is_owner = 1, display_name = 'Dueño' WHERE id = ?").bind(u.id).run();
  return u;
}
async function inviteToken(owner: TestUser) {
  const j = await json(pcall("POST", "/api/invites", {}, owner.cookie));
  return j.url.split("?c=")[1] as string;
}
/** Sign up through an invite with Face ID (or the password path); returns her cookie, id, passkey and backup code. */
async function member(owner: TestUser, o: { password?: boolean; username?: string } = {}) {
  const token = await inviteToken(owner);
  const username = o.username ?? newName();
  const opt = await json(pcall("POST", "/api/signup/options", { token, username, display_name: "Persona", lang: "es" }));
  const auth = await Authenticator.create();
  const body = o.password ? { token, ticket: opt.ticket, password_key: KEY } : { token, response: await auth.register(opt.options, OK) };
  const res = await pcall("POST", "/api/signup", body);
  expect(res.status).toBe(200);
  const id = (await db().prepare("SELECT id FROM users WHERE username = ?").bind(username).first<{ id: number }>())!.id;
  return { id, username, auth, cookie: cookieOf(res), backup: (await res.json<{ backup_code: string }>()).backup_code, pwSalt: opt.pw_salt as string };
}
async function lockOn(cookie: string, auth: Authenticator) {
  const opt = await json(pcall("POST", "/api/unlock/options", {}, cookie));
  const r = await json(pcall("POST", "/api/unlock", { response: await auth.authenticate(opt.options, OK), enable: true }, cookie));
  expect(r.app_lock).toBe(true);
  return r.unlock as string;
}

describe("Seguridad (Cuentas review): one IP counter for every way in", () => {
  it("login, password salt, Face ID, invites and sign-up share login's 10 a minute; mixing routes gives no extra tries", async () => {
    const ip = "198.51.100.91";
    const tries: [string, unknown][] = [
      ["/api/login", { username: "x", passphrase: "wrong" }], ["/api/login/salt", { username: "x" }],
      ["/api/login/passkey/options", {}], ["/api/invite", { token: "y".repeat(43) }], ["/api/reset", { token: "y".repeat(43) }],
    ];
    for (let i = 0; i < 10; i++) {
      const [path, body] = tries[i % tries.length];
      expect((await pcall("POST", path, body, undefined, ip)).status, path).not.toBe(429);
    }
    for (const path of ["/api/login", "/api/login/password", "/api/login/salt", "/api/login/passkey/options", "/api/login/passkey", "/api/invite",
      "/api/signup/options", "/api/signup", "/api/reset", "/api/reset/options", "/api/reset/finish"]) {
      const r = await pcall("POST", path, {}, undefined, ip);
      expect(r.status, path).toBe(429);
      expect(await r.json()).toMatchObject({ error: "slow_down" });
    }
  });

  it("the signed-in Face ID routes count on the same counter", async () => {
    const u = await makeUser("rl");
    const ip = "198.51.100.92";
    for (let i = 0; i < 10; i++) await pcall("POST", "/api/login/passkey/options", {}, undefined, ip);
    for (const path of ["/api/unlock/options", "/api/unlock", "/api/passkeys/options", "/api/passkeys"]) {
      expect((await pcall("POST", path, {}, u.cookie, ip)).status, path).toBe(429);
    }
  });
});

describe("Seguridad (Cuentas review): the password salt", () => {
  it("is the same for a name before sign-up, after it and after a new password, so it never shows who has an account", async () => {
    const owner = await makeOwner();
    const username = newName("pw");
    const before = (await json(pcall("POST", "/api/login/salt", { username }))).salt;
    const m = await member(owner, { password: true, username });
    expect(m.pwSalt).toBe(before);
    expect((await json(pcall("POST", "/api/login/salt", { username }))).salt).toBe(before);
    const mine = await json(pcall("POST", "/api/me/password/salt", {}, m.cookie));
    expect(mine.salt).toBe(before);
    // A salt of the page's choice is refused; her name's salt works and ends her other sessions as before.
    const fh = await freshProof(m.cookie);
    expect((await pcall("PUT", "/api/me/password", { salt: "0".repeat(32), key: KEY }, m.cookie, undefined, fh)).status).toBe(400);
    const set = await pcall("PUT", "/api/me/password", { salt: mine.salt, key: "cd".repeat(32) }, m.cookie, undefined, fh);
    expect(set.status).toBe(200);
    expect((await json(pcall("POST", "/api/login/salt", { username }))).salt).toBe(before);
    expect((await call("POST", "/api/login/password", { username, key: "cd".repeat(32) }, undefined, { "cf-connecting-ip": "10.66.0.1" })).status).toBe(200);
  });

  it("is refused when the server key is missing, instead of a salt anyone could work out", async () => {
    const row = (await db().prepare("SELECT value FROM app_keys WHERE name = 'fake_salt'").first<{ value: string }>())!;
    await db().prepare("DELETE FROM app_keys WHERE name = 'fake_salt'").run();
    try {
      const r = await pcall("POST", "/api/login/salt", { username: "nadie" });
      expect(r.status).toBe(500);
      expect(await r.json()).toEqual({ error: "server" });
    } finally {
      await db().prepare("INSERT INTO app_keys (name, value) VALUES ('fake_salt', ?)").bind(row.value).run();
    }
    expect((await pcall("POST", "/api/login/salt", { username: "nadie" })).status).toBe(200);
  });
});

describe("Seguridad (Cuentas review): Face ID reset links are never hidden from her", () => {
  it("she sees each reset link the owner made for her, open or used, and who made it; nobody else does", async () => {
    const owner = await makeOwner();
    const m = await member(owner);
    const other = await member(owner);
    const made = await json(pcall("POST", `/api/members/${m.id}/reset`, {}, owner.cookie, freshIp(), await freshProof(owner.cookie)));
    const token = made.url.split("?c=")[1];
    // Her own Face ID still works until the link is used: she signs in and sees that a link exists.
    const opt = await json(pcall("POST", "/api/login/passkey/options", {}));
    const back = await pcall("POST", "/api/login/passkey", { response: await m.auth.authenticate(opt.options, OK) });
    const acc1 = await json(call("GET", "/api/account", undefined, cookieOf(back)));
    expect(acc1.resets).toEqual([expect.objectContaining({ made_at: expect.any(Number), used_at: null, by: "Dueño", status: "pending" })]);
    // Someone uses the link (she, or whoever holds it), once its 24 hours have passed.
    await ripen(made.id);
    const fresh = await Authenticator.create();
    const ro = await json(pcall("POST", "/api/reset/options", { token }));
    const fin = await pcall("POST", "/api/reset/finish", { token, response: await fresh.register(ro.options, OK) });
    expect(fin.status).toBe(200);
    // Her next sign-in (the backup code, since her old Face ID is gone) shows when it was used.
    const r = await login(m.username, m.backup, "10.66.0.2");
    expect(r.status).toBe(200);
    const acc2 = await json(call("GET", "/api/account", undefined, cookieOf(r)));
    expect(acc2.resets).toHaveLength(1);
    expect(acc2.resets[0]).toEqual(expect.objectContaining({ used_at: expect.any(Number), by: "Dueño", status: "used" }));
    expect(JSON.stringify(acc2)).not.toContain(token);
    expect(JSON.stringify(acc2)).not.toContain(await sha256Hex(token));
    expect((await json(call("GET", "/api/account", undefined, other.cookie))).resets).toEqual([]);
    // A cancelled link stays in her history too, with who cancelled it (Melvin's decision, Nov 25 2026).
    const made2 = await json(pcall("POST", `/api/members/${other.id}/reset`, {}, owner.cookie, freshIp(), await freshProof(owner.cookie)));
    expect((await pcall("DELETE", `/api/invites/${made2.id}`, {}, owner.cookie)).status).toBe(200);
    const o2 = await login(other.username, other.backup, "10.66.0.3");
    expect((await json(call("GET", "/api/account", undefined, cookieOf(o2)))).resets)
      .toEqual([expect.objectContaining({ status: "cancelled", cancelled_by: "owner", by: "Dueño" })]);
  });
});

describe("Seguridad (Cuentas review): devices list", () => {
  it("leaves out a session past the 180-day limit (which no longer works anyway)", async () => {
    const u = await makeUser("old");
    const old = cookieOf(await login(u.username, "abcde-fghjk-mnpqr-stuvw-xyz23", "10.66.0.4"));
    await db().prepare("UPDATE sessions SET created_at = ? WHERE token_hash = ?").bind(Date.now() - 181 * DAY, await sha256Hex(old.split("=")[1])).run();
    expect(await alive(old)).toBe(401);
    const acc = await json(call("GET", "/api/account", undefined, u.cookie));
    expect(acc.sessions).toHaveLength(1);
    expect(acc.sessions[0].current).toBe(true);
  });
});

// Routes that work without a session (registered before requireUser). Every other route must refuse a locked session.
const PUBLIC = new Set(["POST /api/login", "POST /api/login/salt", "POST /api/login/password", "POST /api/login/passkey/options",
  "POST /api/login/passkey", "POST /api/invite", "POST /api/signup/options", "POST /api/signup", "POST /api/reset", "POST /api/reset/options",
  "POST /api/reset/finish"]);
const OPEN_WHEN_LOCKED = new Set(["POST /api/logout", "POST /api/logout-all", "POST /api/unlock/options", "POST /api/unlock"]);

describe("Seguridad (Cuentas review): the Face ID lock is default deny", () => {
  it("every route the app has answers 423 to a locked session without the proof, except sign out and the Face ID check", async () => {
    const owner = await makeOwner();
    const m = await member(owner);
    const proof = await lockOn(m.cookie, m.auth);
    const routes = app.routes.filter((r) => r.method !== "ALL" && !PUBLIC.has(`${r.method} ${r.path}`) && !OPEN_WHEN_LOCKED.has(`${r.method} ${r.path}`));
    expect(routes.length).toBeGreaterThan(30);
    for (const r of routes) {
      const path = r.path.replace(/:[a-z]+/g, "1") + (r.path.includes("?") ? "" : "?month=2026-11");
      const variants: Record<string, string>[] = [{}, { "x-fz-unlock": "wrong" }, { "x-fz-unlock": proof.slice(0, -1) + (proof.endsWith("A") ? "B" : "A") }];
      for (const headers of variants) {
        const res = await call(r.method, path, r.method === "GET" ? undefined : {}, m.cookie, headers);
        expect(res.status, `${r.method} ${r.path}`).toBe(423);
        expect(await res.json()).toEqual({ error: "unlock" });
      }
    }
    // A route nobody registered is refused the same way (nothing leaks a 404 shape past the lock).
    expect((await call("GET", "/api/nope", undefined, m.cookie)).status).toBe(423);
    // Every route that is not public refuses no session at all.
    for (const r of routes.slice(0, 10)) expect((await call(r.method, r.path.replace(/:[a-z]+/g, "1"), r.method === "GET" ? undefined : {})).status).toBe(401);
    // With the proof, the same session works; nothing was written by the refused calls.
    expect(await alive(m.cookie, { "x-fz-unlock": proof })).toBe(200);
    expect((await db().prepare("SELECT app_lock FROM users WHERE id = ?").bind(m.id).first<{ app_lock: number }>())!.app_lock).toBe(1);
    expect((await db().prepare("SELECT COUNT(*) AS n FROM passkeys WHERE user_id = ?").bind(m.id).first<{ n: number }>())!.n).toBe(1);
  });
});
