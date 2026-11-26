// Cuentas (Wave 2): invites, sign-up, passkeys, password fallback, backup code, Face ID lock, devices,
// owner routes, Primeros pasos state and account deletion.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { hashPassphrase, newSalt, sha256Hex } from "../src/lib/auth.ts";
import { DEFAULT_GROUPS, PERSONAL_GROUPS } from "../src/lib/defaults.ts";
import { STEPS } from "../src/lib/steps.ts";
import { newUserStatements, toD1, toSqlText } from "../src/lib/users.ts";
import { call, cookieOf, freshProof, json, login, makeUser, PASS, type TestUser } from "./helpers.ts";
import { Authenticator, type Opts } from "./webauthn.ts";

const db = () => env.DB;
const ORIGIN = env.APP_ORIGIN;
const RP = env.RP_ID;
const OK: Opts = { origin: ORIGIN, rpId: RP };
const KEY = "ab".repeat(32); // a PBKDF2 result as the phone sends it (the server never sees the password)
const DAY = 24 * 60 * 60 * 1000;

// Passkey and invite routes count per IP like login (10 a minute): every call gets its own made-up address unless given one.
let ipN = 0;
const freshIp = () => `172.20.${(++ipN >> 8) & 255}.${ipN & 255}`;
const pcall = (method: string, path: string, body?: unknown, cookie?: string, ip = freshIp(), headers: Record<string, string> = {}) =>
  call(method, path, body, cookie, { "cf-connecting-ip": ip, ...headers });

let nameN = 0;
const newName = (p = "ana") => `${p}${++nameN}${Math.random().toString(36).slice(2, 6)}`;

async function makeOwner(): Promise<TestUser> {
  const u = await makeUser("own");
  await db().prepare("UPDATE users SET is_owner = 1 WHERE id = ?").bind(u.id).run();
  return u;
}

async function invite(owner: TestUser) {
  const r = await pcall("POST", "/api/invites", {}, owner.cookie);
  expect(r.status).toBe(200);
  const j = await r.json<{ id: number; url: string; expires_at: number }>();
  return { ...j, token: j.url.split("?c=")[1] };
}

type SignUp = { res: Response; auth: Authenticator; username: string; cookie: string; ticket: string; pw_salt: string };

async function signUp(token: string, o: { username?: string; password?: boolean; reg?: Partial<Opts>; auth?: Authenticator } = {}): Promise<SignUp> {
  const username = o.username ?? newName();
  const opt = await json(pcall("POST", "/api/signup/options", { token, username, display_name: "Persona Prueba", lang: "es" }));
  const auth = o.auth ?? (await Authenticator.create());
  const body = o.password
    ? { token, ticket: opt.ticket, password_key: KEY }
    : { token, response: await auth.register(opt.options, { ...OK, ...o.reg }) };
  const res = await pcall("POST", "/api/signup", body);
  return { res, auth, username, cookie: cookieOf(res), ticket: opt.ticket, pw_salt: opt.pw_salt };
}

async function newMember(owner?: TestUser) {
  const own = owner ?? (await makeOwner());
  const s = await signUp((await invite(own)).token);
  expect(s.res.status).toBe(200);
  const id = (await db().prepare("SELECT id FROM users WHERE username = ?").bind(s.username).first<{ id: number }>())!.id;
  const backup = (await s.res.clone().json<{ backup_code: string }>()).backup_code;
  return { ...s, id, owner: own, backup };
}

async function passkeyLogin(auth: Authenticator, o: Partial<Opts> = {}, ip?: string) {
  const opt = await json(pcall("POST", "/api/login/passkey/options", {}, undefined, ip));
  return pcall("POST", "/api/login/passkey", { response: await auth.authenticate(opt.options, { ...OK, ...o }) }, undefined, ip);
}

async function addPasskey(cookie: string, headers: Record<string, string> = {}) {
  const auth = await Authenticator.create();
  const opt = await json(pcall("POST", "/api/passkeys/options", {}, cookie, undefined, headers));
  const res = await pcall("POST", "/api/passkeys", { response: await auth.register(opt.options, OK) }, cookie, undefined, headers);
  return { auth, res, cookie: cookieOf(res) };
}

async function unlock(cookie: string, auth: Authenticator, enable = false) {
  const opt = await json(pcall("POST", "/api/unlock/options", {}, cookie));
  const r = await pcall("POST", "/api/unlock", { response: await auth.authenticate(opt.options, OK), enable }, cookie);
  return { r, body: await r.clone().json<{ unlock: string; app_lock: boolean }>() };
}

const alive = async (cookie: string, headers: Record<string, string> = {}) =>
  (await call("GET", "/api/bootstrap", undefined, cookie, headers)).status;

describe("invites", () => {
  it("only the owner makes, lists and cancels them; at most 2 open; the link's origin is the config's", async () => {
    const owner = await makeOwner();
    const other = await makeUser("noown");
    for (const [m, p] of [["POST", "/api/invites"], ["GET", "/api/members"], ["DELETE", "/api/invites/1"], ["POST", `/api/members/${owner.id}/reset`], ["DELETE", `/api/members/${owner.id}`]]) {
      const r = await pcall(m, p, m === "GET" ? undefined : { confirm: owner.username }, other.cookie);
      expect(r.status, `${m} ${p}`).toBe(403);
      expect(await r.json()).toEqual({ error: "owner_only" });
    }
    const a = await invite(owner);
    expect(a.url.startsWith(`${ORIGIN}/#/unirse?c=`)).toBe(true);
    expect(a.url).not.toContain("finanzas.test"); // never from the Host header
    expect(a.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.expires_at - Date.now()).toBeGreaterThan(7 * DAY - 60_000);
    // Only the hash is stored.
    const row = await db().prepare("SELECT token_hash FROM invites WHERE id = ?").bind(a.id).first<{ token_hash: string }>();
    expect(row!.token_hash).toBe(await sha256Hex(a.token));
    const b = await invite(owner);
    const third = await pcall("POST", "/api/invites", {}, owner.cookie);
    expect(third.status).toBe(409);
    expect(await third.json()).toEqual({ error: "too_many_invites" });
    // Two at the same moment cannot make a third either.
    expect((await pcall("DELETE", `/api/invites/${b.id}`, {}, owner.cookie)).status).toBe(200);
    const both = await Promise.all([pcall("POST", "/api/invites", {}, owner.cookie), pcall("POST", "/api/invites", {}, owner.cookie)]);
    expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
    // Cancelled: the same answer as any bad invite; cancelling twice is a 404.
    expect((await pcall("POST", "/api/invite", { token: b.token })).status).toBe(404);
    expect((await pcall("DELETE", `/api/invites/${b.id}`, {}, owner.cookie)).status).toBe(404);
    const list = await json(pcall("GET", "/api/members", undefined, owner.cookie));
    expect(list.invites.map((i: { id: number }) => i.id)).toContain(a.id);
    expect(list.invites.map((i: { id: number }) => i.id)).not.toContain(b.id);
  });

  it("one answer for a wrong, used, cancelled or expired invite", async () => {
    const owner = await makeOwner();
    const ok = await invite(owner);
    expect(await json(pcall("POST", "/api/invite", { token: ok.token }))).toMatchObject({ inviter: owner.username });
    const used = await invite(owner);
    expect((await signUp(used.token)).res.status).toBe(200);
    await pcall("DELETE", `/api/invites/${ok.id}`, {}, owner.cookie);
    // An expired one (expiry cannot be changed later: invites_fixed), made straight in the database.
    const expiredToken = "e".repeat(43);
    await db().prepare("INSERT INTO invites (owner_id, kind, token_hash, created_at, expires_at) VALUES (?, 'signup', ?, ?, ?)")
      .bind(owner.id, await sha256Hex(expiredToken), Date.now() - 8 * DAY, Date.now() - DAY).run();
    for (const token of ["x".repeat(43), "short", used.token, ok.token, expiredToken]) {
      for (const path of ["/api/invite", "/api/signup/options", "/api/signup"]) {
        const r = await pcall("POST", path, { token, username: newName(), display_name: "X", lang: "es", ticket: "t", password_key: KEY });
        expect(r.status, `${path} ${token.slice(0, 5)}`).toBe(404);
        expect(await r.json()).toEqual({ error: "invite_invalid" });
      }
    }
    await expect(db().prepare("UPDATE invites SET expires_at = ? WHERE id = ?").bind(Date.now() + DAY, ok.id).run()).rejects.toThrow(/user_id_fixed/);
  });

  it("a cancel while she is signing up stops the sign-up", async () => {
    const owner = await makeOwner();
    const inv = await invite(owner);
    const opt = await json(pcall("POST", "/api/signup/options", { token: inv.token, username: newName(), display_name: "X", lang: "es" }));
    await pcall("DELETE", `/api/invites/${inv.id}`, {}, owner.cookie);
    const auth = await Authenticator.create();
    const r = await pcall("POST", "/api/signup", { token: inv.token, response: await auth.register(opt.options, OK) });
    expect(r.status).toBe(404);
  });
});

describe("sign-up", () => {
  it("makes the user, her starter groups (no limits), passkey and session in one step, and shows the backup code once", async () => {
    const m = await newMember();
    const body = await m.res.clone().json<{ ok: boolean; backup_code: string }>();
    expect(Object.keys(body).sort()).toEqual(["backup_code", "ok"]);
    expect(body.backup_code).toMatch(/^[a-z2-9]{5}(-[a-z2-9]{5}){4}$/);
    const u = await db().prepare("SELECT * FROM users WHERE id = ?").bind(m.id).first<Record<string, unknown>>();
    expect(u!.is_owner).toBe(0);
    expect(u!.pass_hash).toBe(await hashPassphrase(body.backup_code, u!.pass_salt as string)); // same hash as today's login
    expect(JSON.stringify(u)).not.toContain(body.backup_code);
    expect(await alive(m.cookie)).toBe(200);
    const boot = await json(call("GET", "/api/bootstrap", undefined, m.cookie));
    const expected = DEFAULT_GROUPS.filter((g) => !PERSONAL_GROUPS.has(g.name));
    expect(boot.groups.map((g: { name: string }) => g.name)).toEqual(expected.map((g) => g.name));
    expect(boot.groups.every((g: { limit_cents: null }) => g.limit_cents === null)).toBe(true);
    expect(boot.categories.length).toBe(expected.reduce((n, g) => n + g.cats.length, 0));
    expect(boot.accounts.map((a: { name: string }) => a.name)).toEqual(["Efectivo"]);
    expect((await db().prepare("SELECT COUNT(*) AS n FROM passkeys WHERE user_id = ?").bind(m.id).first<{ n: number }>())!.n).toBe(1);
    const setup = await json(call("GET", "/api/setup", undefined, m.cookie));
    expect(setup.card).toBe("open");
    expect(setup.has_movements).toBe(false);
  });

  it("an invite works once, even for two sign-ups at the same moment", async () => {
    const owner = await makeOwner();
    const inv = await invite(owner);
    const first = await signUp(inv.token);
    expect(first.res.status).toBe(200);
    expect((await pcall("POST", "/api/signup/options", { token: inv.token, username: newName(), display_name: "X", lang: "es" })).status).toBe(404);

    const race = await invite(owner);
    const names = [newName("r"), newName("r")];
    const opts = await Promise.all(names.map((username) => json(pcall("POST", "/api/signup/options", { token: race.token, username, display_name: "X", lang: "es" }))));
    const results = await Promise.all(opts.map(async (o) => pcall("POST", "/api/signup", { token: race.token, response: await (await Authenticator.create()).register(o.options, OK) })));
    expect(results.map((r) => r.status).sort()).toEqual([200, 404]);
    const made = await db().prepare(`SELECT COUNT(*) AS n FROM users WHERE username IN (?, ?)`).bind(...names).first<{ n: number }>();
    expect(made!.n).toBe(1);
  });

  it("rolls everything back when the invite was used between the check and the save (trigger)", async () => {
    const owner = await makeOwner();
    const inv = await invite(owner);
    await db().prepare("UPDATE invites SET used_at = ? WHERE id = ?").bind(Date.now(), inv.id).run();
    const ghost = newName("ghost");
    const stmts = newUserStatements({ username: ghost, displayName: "G", lang: "es", passSalt: newSalt(), passHash: "0".repeat(64), owner: "never", defaults: true, setupCard: "open", now: Date.now() });
    await expect(db().batch([db().prepare("UPDATE invites SET used_at = ? WHERE id = ?").bind(Date.now(), inv.id), ...toD1(db(), stmts)])).rejects.toThrow(/invite_closed/);
    expect(await db().prepare("SELECT 1 FROM users WHERE username = ?").bind(ghost).first()).toBeNull();
    expect(await db().prepare("SELECT 1 FROM groups g JOIN users u ON u.id = g.user_id WHERE u.username = ?").bind(ghost).first()).toBeNull();
    // A cancelled or expired invite is refused by the same trigger.
    await expect(db().prepare("UPDATE invites SET cancelled_at = ? WHERE id = ?").bind(Date.now(), inv.id).run()).rejects.toThrow(/invite_closed/);
  });

  it("checks the name: format, taken, and only owners make invites even straight in the database", async () => {
    const owner = await makeOwner();
    const inv = await invite(owner);
    for (const username of ["ab", "has space", "x".repeat(33), "ñandú"]) {
      const r = await pcall("POST", "/api/signup/options", { token: inv.token, username, display_name: "X", lang: "es" });
      expect(r.status, username).toBe(400);
    }
    const taken = await pcall("POST", "/api/signup/options", { token: inv.token, username: owner.username, display_name: "X", lang: "es" });
    expect(taken.status).toBe(409);
    expect(await taken.json()).toEqual({ error: "name_taken" });
    const plain = await makeUser("plain");
    await expect(db().prepare("INSERT INTO invites (owner_id, kind, token_hash, created_at, expires_at) VALUES (?, 'signup', 'h', 1, 2)").bind(plain.id).run()).rejects.toThrow(/owner_only/);
  });

  it("the script and the Worker share one way of making a user (add-user.ts SQL)", async () => {
    const username = newName("script");
    const sql = toSqlText(newUserStatements({ username, displayName: "O'Neil", lang: "en", passSalt: newSalt(), passHash: "1".repeat(64), owner: "first", defaults: true, setupCard: "hidden", now: Date.now() }));
    expect(sql).not.toContain("?");
    await db().exec(sql);
    const u = await db().prepare("SELECT id, is_owner, display_name FROM users WHERE username = ?").bind(username).first<{ id: number; is_owner: number; display_name: string }>();
    expect(u).toMatchObject({ is_owner: 0, display_name: "O'Neil" }); // not the first user, so not the owner
    expect((await db().prepare("SELECT state FROM setup_steps WHERE user_id = ? AND step = 'card'").bind(u!.id).first<{ state: string }>())!.state).toBe("hidden");
    expect((await db().prepare("SELECT COUNT(*) AS n FROM groups WHERE user_id = ?").bind(u!.id).first<{ n: number }>())!.n).toBe(DEFAULT_GROUPS.length - PERSONAL_GROUPS.size);
  });
});

describe("passkeys", () => {
  it("sign in with Face ID; a challenge works once and for 5 minutes only", async () => {
    const m = await newMember();
    const ip = freshIp();
    const opt = await json(pcall("POST", "/api/login/passkey/options", {}, undefined, ip));
    expect(opt.options.userVerification).toBe("required");
    expect(opt.options.rpId).toBe(RP);
    const resp = await m.auth.authenticate(opt.options, OK);
    const r = await pcall("POST", "/api/login/passkey", { response: resp }, undefined, ip);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
    expect(await alive(cookieOf(r))).toBe(200);
    // The same answer again: the challenge is gone.
    const replay = await pcall("POST", "/api/login/passkey", { response: resp }, undefined, ip);
    expect(replay.status).toBe(400);
    expect(await replay.json()).toEqual({ error: "bad_passkey" });
    // An expired challenge.
    const late = await json(pcall("POST", "/api/login/passkey/options", {}));
    await db().prepare("UPDATE webauthn_challenges SET expires_at = ? WHERE challenge = ?").bind(Date.now() - 1, late.options.challenge).run();
    expect((await pcall("POST", "/api/login/passkey", { response: await m.auth.authenticate(late.options, OK) })).status).toBe(400);
    const stored = await db().prepare("SELECT expires_at FROM webauthn_challenges ORDER BY expires_at DESC LIMIT 1").first<{ expires_at: number }>();
    expect(stored!.expires_at - Date.now()).toBeLessThanOrEqual(5 * 60 * 1000);
  });

  it("refuses the wrong origin, the wrong rpID, no user verification, a made-up challenge and an unknown key", async () => {
    const m = await newMember();
    for (const bad of [{ origin: "https://evil.test" }, { origin: "http://localhost:9999" }, { rpId: "evil.test" }, { uv: false }, { type: "webauthn.create" }]) {
      const r = await passkeyLogin(m.auth, bad);
      expect(r.status, JSON.stringify(bad)).toBe(400);
      expect(r.headers.get("set-cookie")).toBeNull();
    }
    const fake = await m.auth.authenticate({ challenge: "bm90LWEtcmVhbC1jaGFsbGVuZ2U" }, OK);
    expect((await pcall("POST", "/api/login/passkey", { response: fake })).status).toBe(400);
    expect((await passkeyLogin(await Authenticator.create())).status).toBe(400);
    expect((await passkeyLogin(m.auth)).status).toBe(200); // the right one still works
  });

  it("refuses sign-up with the wrong origin or rpID, no user verification, or any attestation but none", async () => {
    const owner = await makeOwner();
    const inv = await invite(owner);
    const cases: [Partial<Opts>, string][] = [
      [{ fmt: "packed", x5c: true }, "attestation"],
      [{ fmt: "fido-u2f", x5c: true }, "attestation"],
      [{ fmt: "tpm" }, "attestation"],
      [{ fmt: "android-key" }, "attestation"],
      [{ origin: "https://evil.test" }, "bad_passkey"],
      [{ rpId: "evil.test" }, "bad_passkey"],
      [{ uv: false }, "bad_passkey"],
      [{ type: "webauthn.get" }, "bad_passkey"],
    ];
    for (const [reg, error] of cases) {
      const s = await signUp(inv.token, { reg });
      expect(s.res.status, JSON.stringify(reg)).toBe(400);
      expect(await s.res.json()).toEqual({ error });
      expect(await db().prepare("SELECT 1 FROM users WHERE username = ?").bind(s.username).first()).toBeNull();
    }
    // Packed self-attestation (no certificate chain) is fine, and the invite still works after the failures.
    expect((await signUp(inv.token, { reg: { fmt: "packed" } })).res.status).toBe(200);
  });

  it("challenges are tied to their purpose, user and session", async () => {
    const m = await newMember();
    const b = await makeUser("tie");
    // A's "add a device" challenge, answered from B's session.
    const opt = await json(pcall("POST", "/api/passkeys/options", {}, m.cookie, undefined, await freshProof(m.cookie)));
    const resp = await (await Authenticator.create()).register(opt.options, OK);
    expect((await pcall("POST", "/api/passkeys", { response: resp }, b.cookie, undefined, await freshProof(b.cookie))).status).toBe(400);
    // A login challenge cannot be used to unlock.
    const lo = await json(pcall("POST", "/api/login/passkey/options", {}));
    expect((await pcall("POST", "/api/unlock", { response: await m.auth.authenticate(lo.options, OK) }, m.cookie)).status).toBe(400);
    // A's unlock challenge from another session of A.
    const second = cookieOf(await passkeyLogin(m.auth));
    const un = await json(pcall("POST", "/api/unlock/options", {}, second));
    expect((await pcall("POST", "/api/unlock", { response: await m.auth.authenticate(un.options, OK) }, m.cookie)).status).toBe(400);
  });

  it("are rate limited per IP like login, with counters that hold no address", async () => {
    const ip = "198.51.100.77";
    for (let i = 0; i < 10; i++) expect((await pcall("POST", "/api/login/passkey/options", {}, undefined, ip)).status).toBe(200);
    const r = await pcall("POST", "/api/login/passkey/options", {}, undefined, ip);
    expect(r.status).toBe(429);
    expect(await r.json()).toMatchObject({ error: "slow_down" });
    expect((await pcall("POST", "/api/invite", { token: "x".repeat(43) }, undefined, ip)).status).toBe(429);
    const { results } = await db().prepare("SELECT k FROM login_limits").all<{ k: string }>();
    for (const { k } of results) expect(k).toMatch(/^(ip|name):[0-9a-f]{64}$/);
  });
});

describe("backup code (the passphrase once she has Face ID)", () => {
  it("locks after 5 wrong tries like M1", async () => {
    const m = await newMember();
    for (let i = 1; i <= 4; i++) {
      const r = await login(m.username, "wrong-code");
      expect(r.status).toBe(401);
      expect((await r.json<{ tries_left: number }>()).tries_left).toBe(5 - i);
    }
    expect((await login(m.username, "wrong-code")).status).toBe(429);
    expect((await login(m.username, m.backup)).status).toBe(429);
  });

  it("using it ends all her sessions, turns the lock off and asks for a new Face ID", async () => {
    const m = await newMember();
    const other = cookieOf(await passkeyLogin(m.auth));
    await unlock(m.cookie, m.auth, true);
    const r = await login(m.username, m.backup);
    expect(r.status).toBe(200);
    // the code she just typed is a fresh check: the page gets a proof to add a Face ID again (the lock stays off)
    expect(await r.json()).toEqual({ ok: true, backup_used: true, fresh: expect.any(String) });
    expect(await alive(m.cookie)).toBe(401);
    expect(await alive(other)).toBe(401);
    expect(await alive(cookieOf(r))).toBe(200); // lock is off now, no proof needed
    expect((await json(call("GET", "/api/account", undefined, cookieOf(r)))).app_lock).toBe(false);
  });

  it("for someone with only a passphrase (Melvin today), login is unchanged", async () => {
    const u = await makeUser("melv");
    const second = await login(u.username, PASS);
    expect(await second.json()).toEqual({ ok: true });
    expect(await alive(u.cookie)).toBe(200);
  });

  it("a new backup code replaces the old one and ends her other sessions", async () => {
    const m = await newMember();
    const other = cookieOf(await passkeyLogin(m.auth));
    const r = await pcall("POST", "/api/me/backup-code", {}, m.cookie, undefined, await freshProof(m.cookie));
    const { backup_code } = await r.json<{ backup_code: string }>();
    expect(await alive(other)).toBe(401);
    expect(await alive(cookieOf(r))).toBe(200);
    expect((await login(m.username, m.backup)).status).toBe(401);
    expect((await login(m.username, backup_code)).status).toBe(200);
  });
});

describe("own password (when Face ID does not work)", () => {
  it("sign-up with a password, then sign in with it; the salt says nothing about who exists", async () => {
    const owner = await makeOwner();
    const s = await signUp((await invite(owner)).token, { password: true });
    expect(s.res.status).toBe(200);
    const id = (await db().prepare("SELECT id, pw_salt, pw_hash FROM users WHERE username = ?").bind(s.username).first<{ id: number; pw_salt: string; pw_hash: string }>())!;
    expect(id.pw_salt).toBe(s.pw_salt);
    expect(id.pw_hash).not.toContain(KEY);
    expect((await db().prepare("SELECT COUNT(*) AS n FROM passkeys WHERE user_id = ?").bind(id.id).first<{ n: number }>())!.n).toBe(0);

    const salt = await json(pcall("POST", "/api/login/salt", { username: s.username }));
    expect(salt).toEqual({ salt: s.pw_salt, iter: 600000 });
    const unknown1 = await json(pcall("POST", "/api/login/salt", { username: "nadie-existe" }));
    const unknown2 = await json(pcall("POST", "/api/login/salt", { username: "NADIE-existe " }));
    const unknown3 = await json(pcall("POST", "/api/login/salt", { username: "otra-persona" }));
    expect(unknown1.salt).toMatch(/^[0-9a-f]{32}$/);
    expect(unknown1).toEqual(unknown2);
    expect(unknown1.salt).not.toBe(unknown3.salt);
    const noPw = await makeUser("nopw");
    expect((await json(pcall("POST", "/api/login/salt", { username: noPw.username }))).salt).toMatch(/^[0-9a-f]{32}$/);

    const ok = await call("POST", "/api/login/password", { username: s.username, key: KEY }, undefined, { "cf-connecting-ip": "10.9.9.1" });
    expect(ok.status).toBe(200);
    expect(await alive(cookieOf(ok))).toBe(200);
    expect((await call("POST", "/api/login/password", { username: s.username, key: "cd".repeat(32) }, undefined, { "cf-connecting-ip": "10.9.9.1" })).status).toBe(401);
    expect((await call("POST", "/api/login/password", { username: noPw.username, key: KEY }, undefined, { "cf-connecting-ip": "10.9.9.1" })).status).toBe(401);
    expect((await call("POST", "/api/login/password", { username: s.username, key: "not-hex" })).status).toBe(400);
  });

  it("shares the M1 counter with the backup code", async () => {
    const owner = await makeOwner();
    const s = await signUp((await invite(owner)).token, { password: true });
    const ip = { "cf-connecting-ip": "10.9.9.2" };
    for (let i = 0; i < 2; i++) expect((await call("POST", "/api/login", { username: s.username, passphrase: "wrong" }, undefined, ip)).status).toBe(401);
    for (let i = 0; i < 2; i++) expect((await call("POST", "/api/login/password", { username: s.username, key: "cd".repeat(32) }, undefined, ip)).status).toBe(401);
    expect((await call("POST", "/api/login/password", { username: s.username, key: "cd".repeat(32) }, undefined, ip)).status).toBe(429);
    expect((await call("POST", "/api/login/password", { username: s.username, key: KEY }, undefined, ip)).status).toBe(429);
  });

  it("setting a password ends her other sessions", async () => {
    const m = await newMember();
    const other = cookieOf(await passkeyLogin(m.auth));
    const { salt } = await json(pcall("POST", "/api/me/password/salt", {}, m.cookie));
    const r = await pcall("PUT", "/api/me/password", { salt, key: KEY }, m.cookie, undefined, await freshProof(m.cookie));
    expect(r.status).toBe(200);
    expect(await alive(other)).toBe(401);
    expect(await alive(m.cookie)).toBe(401);
    expect(await alive(cookieOf(r))).toBe(200);
    expect((await call("POST", "/api/login/password", { username: m.username, key: KEY }, undefined, { "cf-connecting-ip": "10.9.9.3" })).status).toBe(200);
  });
});

describe("sessions end on every login-method change", () => {
  it("adding or removing a Face ID device ends the others; this device gets a new session", async () => {
    const u = await makeUser("lm");
    const second = cookieOf(await login(u.username, PASS));
    const add = await addPasskey(u.cookie, await freshProof(u.cookie));
    expect(add.res.status).toBe(200);
    expect(await alive(u.cookie)).toBe(401);
    expect(await alive(second)).toBe(401);
    expect(await alive(add.cookie)).toBe(200);
    // Melvin's case: his passphrase is now his backup code.
    const other = cookieOf(await passkeyLogin(add.auth));
    const { passkeys } = await json(call("GET", "/api/account", undefined, add.cookie));
    // adding it was a fresh check: its proof covers the next 5 minutes
    const del = await pcall("DELETE", `/api/passkeys/${passkeys[0].id}`, {}, add.cookie, undefined, { "x-fz-unlock": (await add.res.json<{ unlock: string }>()).unlock });
    expect(del.status).toBe(200);
    expect(await alive(other)).toBe(401);
    expect(await alive(add.cookie)).toBe(401);
    expect(await alive(cookieOf(del))).toBe(200);
  });

  it("by any path, straight in the database too", async () => {
    const m = await newMember();
    const pk = await db().prepare("SELECT id FROM passkeys WHERE user_id = ?").bind(m.id).first<{ id: number }>();
    await db().prepare("UPDATE passkeys SET counter = 9 WHERE id = ?").bind(pk!.id).run();
    expect(await alive(m.cookie)).toBe(200); // a counter is not a login method
    await db().prepare("UPDATE users SET backup_used_at = 1 WHERE id = ?").bind(m.id).run();
    expect(await alive(m.cookie)).toBe(401);
    const s2 = cookieOf(await passkeyLogin(m.auth));
    await db().prepare("UPDATE passkeys SET public_key = 'AAAA' WHERE id = ?").bind(pk!.id).run();
    expect(await alive(s2)).toBe(401);
    await expect(db().prepare("UPDATE passkeys SET user_id = ? WHERE id = ?").bind(m.owner.id, pk!.id).run()).rejects.toThrow(/user_id_fixed/);
  });
});

describe("Face ID lock (server enforced)", () => {
  it("money routes refuse a locked session until the page proves a fresh Face ID", async () => {
    const m = await newMember();
    const { r, body } = await unlock(m.cookie, m.auth, true);
    expect(r.status).toBe(200);
    expect(body.app_lock).toBe(true);
    const proof = { "x-fz-unlock": body.unlock };
    for (const [method, path] of [["GET", "/api/bootstrap"], ["GET", "/api/movements"], ["GET", "/api/export.csv"], ["GET", "/api/account"], ["GET", "/api/setup"], ["POST", "/api/movements"], ["PUT", "/api/me"]]) {
      const locked = await call(method, path, method === "GET" ? undefined : {}, m.cookie);
      expect(locked.status, path).toBe(423);
      expect(await locked.json()).toEqual({ error: "unlock" });
      expect((await call(method, path, method === "GET" ? undefined : {}, m.cookie, { "x-fz-unlock": "wrong" })).status).toBe(423);
    }
    expect(await alive(m.cookie, proof)).toBe(200);
    // The proof belongs to this session only.
    const other = cookieOf(await passkeyLogin(m.auth));
    const login2 = await passkeyLogin(m.auth);
    expect(await login2.json()).toMatchObject({ unlock: expect.any(String) }); // Face ID sign-in opens the lock too
    expect(await alive(other, proof)).toBe(423);
    // It runs out (the page drops it sooner: reload or 5 minutes hidden).
    await db().prepare("UPDATE sessions SET unlocked_at = ? WHERE token_hash = ?").bind(Date.now() - 13 * 60 * 60 * 1000, await sha256Hex(m.cookie.split("=")[1])).run();
    expect(await alive(m.cookie, proof)).toBe(423);
    const again = await unlock(m.cookie, m.auth);
    expect(await alive(m.cookie, { "x-fz-unlock": again.body.unlock })).toBe(200);
    // Turning it off needs the proof; turning it on needs a Face ID.
    expect((await call("PUT", "/api/me/lock", { on: false }, m.cookie)).status).toBe(423);
    expect((await call("PUT", "/api/me/lock", { on: true }, m.cookie, { "x-fz-unlock": again.body.unlock })).status).toBe(400);
    expect((await call("PUT", "/api/me/lock", { on: false }, m.cookie, { "x-fz-unlock": again.body.unlock })).status).toBe(200);
    expect(await alive(m.cookie)).toBe(200);
    // Sign out works while locked.
    await unlock(m.cookie, m.auth, true);
    expect((await call("POST", "/api/logout", {}, m.cookie)).status).toBe(200);
  });

  it("goes off with the last Face ID device, and cannot be turned on without one", async () => {
    const u = await makeUser("lk");
    expect((await pcall("POST", "/api/unlock/options", {}, u.cookie)).status).toBe(409);
    const add = await addPasskey(u.cookie, await freshProof(u.cookie));
    const { body } = await unlock(add.cookie, add.auth, true);
    const { passkeys } = await json(call("GET", "/api/account", undefined, add.cookie, { "x-fz-unlock": body.unlock }));
    const del = await pcall("DELETE", `/api/passkeys/${passkeys[0].id}`, {}, add.cookie, undefined, { "x-fz-unlock": body.unlock });
    expect(del.status).toBe(200);
    expect(await alive(cookieOf(del))).toBe(200);
    expect((await db().prepare("SELECT app_lock FROM users WHERE id = ?").bind(u.id).first<{ app_lock: number }>())!.app_lock).toBe(0);
  });
});

describe("devices and sessions", () => {
  it("lists her devices with a plain label, signs out one, and never shows a token", async () => {
    const u = await makeUser("dev");
    const iphone = cookieOf(await call("POST", "/api/login", { username: u.username, passphrase: PASS }, undefined, {
      "cf-connecting-ip": "10.7.7.7", "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1",
    }));
    const acc = await json(call("GET", "/api/account", undefined, u.cookie));
    expect(acc.sessions.length).toBe(2);
    expect(acc.sessions.find((s: { label: string }) => s.label === "iPhone · Safari")).toBeTruthy();
    const cur = acc.sessions.find((s: { current: boolean }) => s.current);
    expect(Object.keys(cur).sort()).toEqual(["created_at", "current", "id", "label", "last_used"]);
    expect(JSON.stringify(acc)).not.toContain(u.cookie.split("=")[1]);
    const phone = acc.sessions.find((s: { current: boolean }) => !s.current);
    expect((await pcall("DELETE", `/api/sessions/${phone.id}`, {}, u.cookie)).status).toBe(200);
    expect(await alive(iphone)).toBe(401);
    expect(await alive(u.cookie)).toBe(200);
    for (const bad of ["zz", "0".repeat(16), phone.id]) expect((await pcall("DELETE", `/api/sessions/${bad}`, {}, u.cookie)).status).toBe(404);
  });
});

describe("cross-user matrix: every new route that takes an id", () => {
  it("B gets 404 for A's sessions, passkeys, invites and setup, and A's rows stay", async () => {
    const ownerA = await makeOwner();
    const ownerB = await makeOwner();
    const a = await newMember(ownerA);
    const b = await newMember(ownerB);
    const accA = await json(call("GET", "/api/account", undefined, a.cookie));
    const invA = await invite(ownerA);
    const snapshot = async () => ({
      sessions: (await db().prepare("SELECT token_hash FROM sessions WHERE user_id = ? ORDER BY 1").bind(a.id).all()).results,
      passkeys: (await db().prepare("SELECT * FROM passkeys WHERE user_id = ? ORDER BY 1").bind(a.id).all()).results,
      invites: (await db().prepare("SELECT * FROM invites WHERE owner_id = ? ORDER BY 1").bind(ownerA.id).all()).results,
      setup: (await db().prepare("SELECT * FROM setup_steps WHERE user_id = ? ORDER BY 2").bind(a.id).all()).results,
    });
    const before = await snapshot();
    const tries: [string, string, string][] = [
      ["DELETE", `/api/sessions/${accA.sessions[0].id}`, b.cookie],
      ["DELETE", `/api/passkeys/${accA.passkeys[0].id}`, b.cookie],
      ["DELETE", `/api/invites/${invA.id}`, ownerB.cookie],
      ["DELETE", "/api/passkeys/abc", b.cookie],
      ["DELETE", "/api/passkeys/999999999", b.cookie],
      ["DELETE", "/api/invites/abc", ownerB.cookie],
      ["PUT", "/api/setup/steps/card", b.cookie],
      ["PUT", "/api/setup/steps/nope", b.cookie],
      ["POST", "/api/members/999999999/reset", ownerB.cookie],
      ["DELETE", "/api/members/999999999", ownerB.cookie],
    ];
    const fb = await freshProof(b.cookie); // so a refusal is the ownership check, not the fresh check
    for (const [m, p, cookie] of tries) {
      const r = await pcall(m, p, { state: "done", confirm: "x" }, cookie, undefined, cookie === b.cookie ? fb : {});
      expect(r.status, `${m} ${p}`).toBe(404);
    }
    // B's setup changes stay B's.
    await pcall("PUT", "/api/setup/steps/accounts", { state: "done" }, b.cookie);
    await pcall("PUT", "/api/setup/card", { hidden: true }, b.cookie);
    expect(await snapshot()).toEqual(before);
    const sa = await json(call("GET", "/api/setup", undefined, a.cookie));
    expect(sa.card).toBe("open");
    expect(sa.steps.find((s: { id: string }) => s.id === "accounts").state).toBe("open");
    expect(await alive(a.cookie)).toBe(200);
  });
});

describe("Primeros pasos state", () => {
  it("lists the 9 steps in the contract order; alerts available (Funciones); BAC emails hidden until the capture exists", async () => {
    const m = await newMember();
    const s = await json(call("GET", "/api/setup", undefined, m.cookie));
    expect(s.steps.map((x: { id: string }) => x.id)).toEqual([...STEPS]);
    expect(s.steps.map((x: { id: string }) => x.id)).toEqual(["home_screen", "accounts", "life", "statements", "savings", "limits", "alerts", "lock", "bac_email"]);
    expect(s.steps.find((x: { id: string }) => x.id === "alerts").available).toBe(true); // Funciones built step 7
    expect(s.steps.find((x: { id: string }) => x.id === "bac_email").applies).toBe(false);
    expect(s.steps.every((x: { state: string }) => x.state === "open")).toBe(true);
    expect(s).toMatchObject({ card: "open", has_movements: false, bac_email_ready: false, has_passkey: true, app_lock: false, limits_ready: false });
  });

  it("stores states (waiting with its time), hides the card, and works out limits, statements and lock", async () => {
    const m = await newMember();
    expect((await pcall("PUT", "/api/setup/steps/limits", { state: "waiting" }, m.cookie)).status).toBe(200);
    expect((await pcall("PUT", "/api/setup/steps/limits", { state: "later" }, m.cookie)).status).toBe(400);
    let s = await json(call("GET", "/api/setup", undefined, m.cookie));
    const limits = s.steps.find((x: { id: string }) => x.id === "limits");
    expect(limits.state).toBe("waiting");
    expect(Math.abs(limits.at - Date.now())).toBeLessThan(60_000);
    // 40 days of data: the card offers limits from her spending.
    const acc = (await db().prepare("SELECT id FROM accounts WHERE user_id = ?").bind(m.id).first<{ id: number }>())!.id;
    const old = new Date(Date.now() - 40 * DAY).toISOString().slice(0, 10);
    await db().prepare(`INSERT INTO movements (user_id, fecha, amount_cents, tipo, comercio, account_id, origen, dedupe_key, created_at, updated_at)
      VALUES (?, ?, 100, 'gasto', 'X', ?, 'Estado de cuenta BAC', ?, 1, 1)`).bind(m.id, old, acc, "t:" + Math.random()).run();
    s = await json(call("GET", "/api/setup", undefined, m.cookie));
    expect(s.limits_ready).toBe(true);
    expect(s.has_movements).toBe(true);
    expect(s.data_days).toBeGreaterThanOrEqual(39);
    expect(s.steps.find((x: { id: string }) => x.id === "statements").state).toBe("done");
    // Any group limit makes limits done.
    await db().prepare("UPDATE groups SET limit_cents = 10000 WHERE user_id = ? AND name = 'Casa'").bind(m.id).run();
    s = await json(call("GET", "/api/setup", undefined, m.cookie));
    expect(s.steps.find((x: { id: string }) => x.id === "limits").state).toBe("done");
    expect(s.limits_ready).toBe(false);
    await unlock(m.cookie, m.auth, true);
    const proof = (await unlock(m.cookie, m.auth)).body.unlock;
    s = await json(call("GET", "/api/setup", undefined, m.cookie, { "x-fz-unlock": proof }));
    expect(s.steps.find((x: { id: string }) => x.id === "lock").state).toBe("done");
    expect((await pcall("PUT", "/api/setup/card", { hidden: true }, m.cookie, undefined, { "x-fz-unlock": proof })).status).toBe(200);
    s = await json(call("GET", "/api/setup", undefined, m.cookie, { "x-fz-unlock": proof }));
    expect(s.card).toBe("hidden");
  });

  it("Tu vida archives or shows only her own starter groups and categories", async () => {
    const owner = await makeOwner();
    const a = await newMember(owner);
    const b = await newMember(owner);
    const answers = { rent: false, vehicle: false, pet: true, work: false, family: true, shared: false, travel: true };
    const r = await pcall("POST", "/api/setup/life", { answers }, a.cookie);
    expect(r.status).toBe(200);
    const arch = async (id: number, table: string, name: string) =>
      (await db().prepare(`SELECT archived FROM ${table} WHERE user_id = ? AND name = ?`).bind(id, name).first<{ archived: number }>())!.archived;
    expect(await arch(a.id, "categories", "Alquiler o cuota")).toBe(1);
    expect(await arch(a.id, "categories", "Gasolina")).toBe(1);
    expect(await arch(a.id, "categories", "Carro")).toBe(1);
    expect(await arch(a.id, "categories", "Mascotas")).toBe(0);
    expect(await arch(a.id, "groups", "Trabajo")).toBe(1);
    expect(await arch(a.id, "groups", "Familia")).toBe(0);
    expect(await arch(a.id, "groups", "Pareja y personas")).toBe(1);
    expect(await arch(a.id, "groups", "Viajes")).toBe(0);
    expect(await arch(b.id, "groups", "Trabajo")).toBe(0);
    expect(await arch(b.id, "categories", "Gasolina")).toBe(0);
    expect((await json(call("GET", "/api/setup", undefined, a.cookie))).life).toEqual(answers);
    expect((await json(call("GET", "/api/setup", undefined, b.cookie))).life).toEqual({});
    expect((await pcall("POST", "/api/setup/life", { answers: { ...answers, extra: true } }, a.cookie)).status).toBe(200);
    expect((await pcall("POST", "/api/setup/life", { answers: { rent: true } }, a.cookie)).status).toBe(400);
  });
});

describe("owner: Personas en la app", () => {
  it("shows names and dates, never amounts", async () => {
    const owner = await makeOwner();
    const m = await newMember(owner);
    const list = await json(call("GET", "/api/members", undefined, owner.cookie));
    const row = list.people.find((p: { id: number }) => p.id === m.id);
    expect(Object.keys(row).sort()).toEqual(["display_name", "id", "is_owner", "joined", "last_seen", "passkeys", "sessions", "username"]);
    expect(row).toMatchObject({ is_owner: false, passkeys: 1, sessions: 1 });
    expect(Object.keys(list).sort()).toEqual(["invites", "max_invites", "people"]);
    expect(JSON.stringify(list)).not.toMatch(/cents|amount|monto|comercio/);
  });

  it("reset Face ID: the link works from 24 h after it is made; using it replaces her passkeys and ends her sessions, once", async () => {
    const owner = await makeOwner();
    const m = await newMember(owner);
    expect((await pcall("POST", `/api/members/${owner.id}/reset`, {}, owner.cookie)).status).toBe(403);
    const r = await json(pcall("POST", `/api/members/${m.id}/reset`, {}, owner.cookie, freshIp(), await freshProof(owner.cookie)));
    expect(r.url.startsWith(`${ORIGIN}/#/restablecer?c=`)).toBe(true);
    expect(r.usable_at - Date.now()).toBeGreaterThan(DAY - 60_000);
    expect(await alive(m.cookie)).toBe(200); // making it no longer ends her sessions (Melvin's decision, Nov 25 2026)
    await db().prepare("UPDATE invites SET created_at = created_at - ? WHERE id = ?").bind(DAY + 60_000, r.id).run();
    const token = r.url.split("?c=")[1];
    expect(await json(pcall("POST", "/api/reset", { token }))).toEqual({ display_name: "Persona Prueba", username: m.username });
    // A reset link is not a sign-up invite, and the other way round.
    expect((await pcall("POST", "/api/invite", { token })).status).toBe(404);
    const fresh = await Authenticator.create();
    const opt = await json(pcall("POST", "/api/reset/options", { token }));
    const fin = await pcall("POST", "/api/reset/finish", { token, response: await fresh.register(opt.options, OK) });
    expect(fin.status).toBe(200);
    expect(await alive(cookieOf(fin))).toBe(200);
    expect(await alive(m.cookie)).toBe(401); // her sessions end when the link is used
    expect((await passkeyLogin(m.auth)).status).toBe(400); // the old passkey is gone
    expect((await passkeyLogin(fresh)).status).toBe(200);
    expect((await pcall("POST", "/api/reset/options", { token })).status).toBe(404);
  });

  it("removes a person and all her rows, with a confirm step; never the owner", async () => {
    const owner = await makeOwner();
    const m = await newMember(owner);
    expect((await pcall("DELETE", `/api/members/${m.id}`, { confirm: "someone-else" }, owner.cookie)).status).toBe(400);
    expect((await pcall("DELETE", `/api/members/${owner.id}`, { confirm: owner.username }, owner.cookie)).status).toBe(403);
    expect((await pcall("DELETE", `/api/members/${m.id}`, { confirm: m.username }, owner.cookie, freshIp(), await freshProof(owner.cookie))).status).toBe(200);
    expect(await db().prepare("SELECT 1 FROM users WHERE id = ?").bind(m.id).first()).toBeNull();
    expect(await alive(m.cookie)).toBe(401);
  });
});

describe("delete my account", () => {
  it("removes her rows from every table that has a user_id; refused for the owner", async () => {
    const owner = await makeOwner();
    const m = await newMember(owner);
    const own = await pcall("DELETE", "/api/me", { confirm: owner.username }, owner.cookie, undefined, await freshProof(owner.cookie));
    expect(own.status).toBe(403);
    expect(await own.json()).toEqual({ error: "owner_cannot_delete" });
    // Rows in every table: a movement, a rule, a suggestion, setup steps, a challenge, a reset link for her.
    const acc = (await db().prepare("SELECT id FROM accounts WHERE user_id = ?").bind(m.id).first<{ id: number }>())!.id;
    const cat = (await db().prepare("SELECT id FROM categories WHERE user_id = ?").bind(m.id).first<{ id: number }>())!.id;
    const mv = async (k: string) => (await db().prepare(`INSERT INTO movements (user_id, fecha, amount_cents, tipo, comercio, account_id, category_id, origen, dedupe_key, created_at, updated_at)
      VALUES (?, '2026-11-20', 500, 'gasto', 'X', ?, ?, 'manual', ?, 1, 1) RETURNING id`).bind(m.id, acc, cat, k).first<{ id: number }>())!.id;
    const m1 = await mv("d1");
    const m2 = await mv("d2");
    await db().prepare("INSERT INTO merchant_rules (user_id, merchant_key, category_id, updated_at) VALUES (?, 'x', ?, 1)").bind(m.id, cat).run();
    await db().prepare("INSERT INTO merge_suggestions (user_id, bank_id, manual_id, created_at) VALUES (?, ?, ?, 1)").bind(m.id, m1, m2).run();
    await pcall("PUT", "/api/setup/steps/accounts", { state: "done" }, m.cookie);
    const fm = await freshProof(m.cookie);
    await pcall("POST", "/api/passkeys/options", {}, m.cookie, undefined, fm);
    expect((await pcall("DELETE", "/api/me", { confirm: "wrong" }, m.cookie, undefined, fm)).status).toBe(400);
    const gone = await pcall("DELETE", "/api/me", { confirm: m.username.toUpperCase() }, m.cookie, undefined, fm);
    expect(gone.status).toBe(200);
    expect(gone.headers.get("set-cookie")).toMatch(/Max-Age=0/);

    const tables = (await db().prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%'").all<{ name: string }>()).results;
    let checked = 0;
    for (const { name } of tables) {
      const cols = (await db().prepare("SELECT name FROM pragma_table_info(?)").bind(name).all<{ name: string }>()).results.map((c) => c.name);
      for (const col of cols.filter((c) => c === "user_id" || c === "target_id")) {
        const n = (await db().prepare(`SELECT COUNT(*) AS n FROM "${name}" WHERE "${col}" = ?`).bind(m.id).first<{ n: number }>())!.n;
        expect(n, `${name}.${col}`).toBe(0);
        checked++;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(11);
    expect(await db().prepare("SELECT 1 FROM users WHERE id = ?").bind(m.id).first()).toBeNull();
    expect(await alive(owner.cookie)).toBe(200);
  });
});
