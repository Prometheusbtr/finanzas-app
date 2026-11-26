// AUDIT (AUTH area, Nov 25 2026), now the regression tests for Wave 3 (F06, F07, F28, F29, F47).
// 1. F06: with the Face ID lock ON, a password sign-in opens the lock but its proof is not the Face ID check the
//    sensitive changes need. With the lock OFF the same password cannot either (control).
// 2. F07 (Melvin's decision): after a backup-code sign-in, the Face IDs made before it stop completely: no sign-in,
//    no unlock, no fresh proof. A Face ID added after it works.
// 3. F29: a login-method change on this phone keeps this phone's push subscription on the new session.
// 4. F28: those routes say whether the lock is on, so the page never turns it on from a proof alone.
// 5. F47: the new session keeps the time of the real check, so a chain of changes cannot outlive its 5 minutes.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { call, cookieOf, freshProof, json, makeUser, type TestUser } from "./helpers.ts";
import { Authenticator, type Opts } from "./webauthn.ts";

const db = () => env.DB;
const OK: Opts = { origin: env.APP_ORIGIN, rpId: env.RP_ID };
const KEY = "ab".repeat(32);
let ipN = 0;
const freshIp = () => `172.41.${(++ipN >> 8) & 255}.${ipN & 255}`;
const pcall = (method: string, path: string, body?: unknown, cookie?: string, headers: Record<string, string> = {}, ip = freshIp()) =>
  call(method, path, body, cookie, { "cf-connecting-ip": ip, ...headers });
const alive = async (cookie: string, headers: Record<string, string> = {}) => (await call("GET", "/api/bootstrap", undefined, cookie, headers)).status;

async function makeOwner(): Promise<TestUser> {
  const u = await makeUser("aown");
  await db().prepare("UPDATE users SET is_owner = 1 WHERE id = ?").bind(u.id).run();
  return u;
}
let nameN = 0;
/** A person who signs up through an invite with a Face ID (software authenticator), as on her iPhone. */
async function member() {
  const owner = await makeOwner();
  const inv = await json(pcall("POST", "/api/invites", {}, owner.cookie));
  const token = inv.url.split("?c=")[1];
  const username = `qaauth${++nameN}${Math.random().toString(36).slice(2, 6)}`;
  const opt = await json(pcall("POST", "/api/signup/options", { token, username, display_name: "Person A", lang: "es" }));
  const auth = await Authenticator.create();
  const res = await pcall("POST", "/api/signup", { token, response: await auth.register(opt.options, OK) });
  expect(res.status).toBe(200);
  const { backup_code } = await res.clone().json<{ backup_code: string }>();
  const id = (await db().prepare("SELECT id FROM users WHERE username = ?").bind(username).first<{ id: number }>())!.id;
  return { id, username, auth, cookie: cookieOf(res), backup: backup_code };
}
async function unlock(cookie: string, auth: Authenticator, enable = false, headers: Record<string, string> = {}) {
  const opt = await json(pcall("POST", "/api/unlock/options", {}, cookie, headers));
  const r = await pcall("POST", "/api/unlock", { response: await auth.authenticate(opt.options, OK), enable }, cookie, headers);
  expect(r.status).toBe(200);
  return r.json<{ unlock: string; app_lock: boolean }>();
}
/** She sets her own password (with a fresh Face ID check), so the account has Face ID + password + backup code. */
async function setPassword(cookie: string) {
  const { salt } = await json(pcall("POST", "/api/me/password/salt", {}, cookie));
  const r = await pcall("PUT", "/api/me/password", { salt, key: KEY }, cookie, await freshProof(cookie));
  expect(r.status).toBe(200);
  return { cookie: cookieOf(r), unlock: (await r.json<{ unlock: string }>()).unlock };
}
async function passwordLogin(username: string) {
  const r = await pcall("POST", "/api/login/password", { username, key: KEY });
  expect(r.status).toBe(200);
  return { cookie: cookieOf(r), body: await r.json<{ ok: boolean; unlock?: string }>() };
}

describe("AUDIT F03 part 1: password sign-in proof passes the Face ID-only fresh check when the lock is on", () => {
  it("control, lock OFF: the password alone cannot make a new backup code (the server asks for Face ID)", async () => {
    const m = await member();
    await setPassword(m.cookie);
    const s = await passwordLogin(m.username);
    expect(s.body.unlock).toBeUndefined();
    const r = await pcall("POST", "/api/me/backup-code", {}, s.cookie);
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: "reauth", method: "passkey" });
    expect((await pcall("POST", "/api/reauth", { key: KEY }, s.cookie)).status).toBe(409); // use_passkey
  });

  it("lock ON: the password sign-in opens the lock, but its proof cannot make a backup code, add a Face ID or delete the account", async () => {
    const m = await member();
    const pw = await setPassword(m.cookie);
    const lock = await unlock(pw.cookie, m.auth, true);
    expect(lock.app_lock).toBe(true);
    // someone who knows only her password, on another device
    const s = await passwordLogin(m.username);
    expect(typeof s.body.unlock).toBe("string");
    const proof = { "x-fz-unlock": s.body.unlock! };
    expect(await alive(s.cookie, proof)).toBe(200); // the lock is open for money
    expect((await pcall("POST", "/api/me/backup-code", {}, s.cookie)).status).toBe(423); // no proof: locked
    const code = await pcall("POST", "/api/me/backup-code", {}, s.cookie, proof);
    expect(code.status).toBe(403);
    expect(await code.json()).toEqual({ error: "reauth", method: "passkey" });
    expect((await pcall("POST", "/api/passkeys/options", {}, s.cookie, proof)).status).toBe(403);
    expect((await pcall("DELETE", "/api/me", { confirm: m.username }, s.cookie, proof)).status).toBe(403);
    expect((await pcall("POST", "/api/reauth", { key: KEY }, s.cookie, proof)).status).toBe(409); // use_passkey
    expect(await alive(pw.cookie, { "x-fz-unlock": lock.unlock })).toBe(200); // her own phone is still signed in
    const n = await db().prepare("SELECT COUNT(*) AS n FROM passkeys WHERE user_id = ?").bind(m.id).first<{ n: number }>();
    expect(n!.n).toBe(1);
  });
});

describe("F06 matrix: every sensitive route takes only a fresh Face ID proof from someone with a Face ID", () => {
  const routes: [string, string, (u: { username: string }) => unknown][] = [
    ["DELETE", "/api/me/resets/1", () => undefined],
    ["POST", "/api/passkeys/options", () => ({})],
    ["POST", "/api/passkeys", () => ({ response: {} })],
    ["DELETE", "/api/passkeys/1", () => undefined],
    ["PUT", "/api/me/password", () => ({ salt: "AAAAAAAAAAAAAAAAAAAAAA", key: KEY })],
    ["POST", "/api/me/backup-code", () => ({})],
    ["PUT", "/api/me/lock", () => ({ on: false })],
    ["DELETE", "/api/me", (u) => ({ confirm: u.username })],
  ];
  it("refuses no proof, a password or passphrase proof, an old Face ID proof (6 min) and accepts a fresh one", async () => {
    const m = await member();
    for (const [method, path, body] of routes) {
      for (const [age, how] of [[0, "password"], [0, "passphrase"], [6 * 60 * 1000, "passkey"]] as const) {
        const r = await pcall(method, path, body(m), m.cookie, await freshProof(m.cookie, age, how));
        expect([path, how, age, r.status]).toEqual([path, how, age, 403]);
        expect(await r.json()).toEqual({ error: "reauth", method: "passkey" });
      }
      const none = await pcall(method, path, body(m), m.cookie);
      expect([path, none.status]).toEqual([path, 403]);
    }
    // the real Face ID check gives a proof these routes take
    const u = await unlock(m.cookie, m.auth);
    const ok = await pcall("POST", "/api/passkeys/options", {}, m.cookie, { "x-fz-unlock": u.unlock });
    expect(ok.status).toBe(200);
  });

  it("someone with no Face ID uses their password or passphrase proof", async () => {
    const u = await makeUser("anopk");
    for (const how of ["password", "passphrase"] as const) {
      const r = await pcall("POST", "/api/passkeys/options", {}, u.cookie, await freshProof(u.cookie, 0, how));
      expect([how, r.status]).toEqual([how, 200]);
    }
  });
});

describe("F07: after the backup code, the old (lost) Face ID stops completely", () => {
  it("the old Face ID cannot sign in, unlock or give a fresh proof; her backup-code session can add a new one, which works", async () => {
    const m = await member();
    // She lost her phone: signs in with the backup code on a new device.
    const rec = await pcall("POST", "/api/login", { username: m.username, passphrase: m.backup });
    expect(rec.status).toBe(200);
    const recBody = await rec.json<{ backup_used: boolean; fresh: string }>();
    expect(recBody.backup_used).toBe(true);
    const herCookie = cookieOf(rec);
    // Whoever holds the lost phone (old passkey) can no longer sign in ...
    const lo = await json(pcall("POST", "/api/login/passkey/options", {}));
    const thief = await pcall("POST", "/api/login/passkey", { response: await m.auth.authenticate(lo.options, OK) });
    expect(thief.status).toBe(400); // bad_passkey
    // ... the lost phone's own session was ended by the backup sign-in ...
    expect(await alive(m.cookie)).toBe(401);
    // ... and no session can get an unlock challenge for the old Face ID
    expect((await pcall("POST", "/api/unlock/options", {}, herCookie)).status).toBe(409); // no_passkey
    // a Face ID proof dated before the backup sign-in is not fresh (even inside the 5 minutes)
    const before = (await db().prepare("SELECT backup_used_at FROM users WHERE id = ?").bind(m.id).first<{ backup_used_at: number }>())!.backup_used_at;
    // (a second backup sign-in, which ends the first one's session: a new backup_used_at is a login change)
    const other = await pcall("POST", "/api/login", { username: m.username, passphrase: m.backup });
    const oc = cookieOf(other);
    const ofresh = (await other.json<{ fresh: string }>()).fresh;
    expect(await alive(herCookie)).toBe(401);
    const b2 = (await db().prepare("SELECT backup_used_at FROM users WHERE id = ?").bind(m.id).first<{ backup_used_at: number }>())!.backup_used_at;
    expect(b2).toBeGreaterThanOrEqual(before);
    const stale = await freshProof(oc, Date.now() - b2 + 1000, "passkey");
    expect((await pcall("POST", "/api/me/backup-code", {}, oc, stale)).status).toBe(403);
    // her backup-code session: the server asks for the passphrase, and the sign-in's own proof counts
    const ask = await pcall("POST", "/api/me/backup-code", {}, oc);
    expect(ask.status).toBe(403);
    expect(await ask.json()).toEqual({ error: "reauth", method: "passphrase" });
    void ofresh; // the stale proof above replaced it: a passphrase proof made now is the same as her sign-in's
    const hp = await freshProof(oc, 0, "passphrase");
    const acct = await json(pcall("GET", "/api/account", undefined, oc, hp));
    expect(acct.passkeys.map((p: { counts: number }) => p.counts)).toEqual([0]);
    const phone = await Authenticator.create();
    const opt = await json(pcall("POST", "/api/passkeys/options", {}, oc, hp));
    const add = await pcall("POST", "/api/passkeys", { response: await phone.register(opt.options, OK) }, oc, hp);
    expect(add.status).toBe(200);
    // the new Face ID signs in; the old one still cannot
    const lo2 = await json(pcall("POST", "/api/login/passkey/options", {}));
    expect((await pcall("POST", "/api/login/passkey", { response: await phone.authenticate(lo2.options, OK) })).status).toBe(200);
    const lo3 = await json(pcall("POST", "/api/login/passkey/options", {}));
    expect((await pcall("POST", "/api/login/passkey", { response: await m.auth.authenticate(lo3.options, OK) })).status).toBe(400);
  });
});

async function subscribe(cookie: string, tag: string) {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const p256dh = btoa(String.fromCharCode(...new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const r = await call("POST", "/api/push/subscription", { endpoint: `https://fcm.googleapis.com/fcm/send/qa-auth-${tag}`, keys: { p256dh, auth: "AAAAAAAAAAAAAAAAAAAAAA" } }, cookie);
  expect(r.status).toBe(201);
}
const subscribed = async (cookie: string, headers: Record<string, string> = {}) =>
  (await json(call("GET", "/api/alerts/prefs", undefined, cookie, headers))).subscribed as boolean;

describe("F29 + F28: a login-method change on this phone keeps this phone's alerts and says the lock's state", () => {
  for (const kind of ["password", "backup-code", "add-passkey", "remove-passkey"] as const) {
    it(`after ${kind}, the same phone's push subscription moves to its new session`, async () => {
      const u = await makeUser("apush");
      await subscribe(u.cookie, `${kind}-${u.id}`);
      expect(await subscribed(u.cookie)).toBe(true);
      let res: Response;
      if (kind === "password") {
        const { salt } = await json(pcall("POST", "/api/me/password/salt", {}, u.cookie));
        res = await pcall("PUT", "/api/me/password", { salt, key: KEY }, u.cookie, await freshProof(u.cookie));
      } else if (kind === "backup-code") {
        res = await pcall("POST", "/api/me/backup-code", {}, u.cookie, await freshProof(u.cookie));
      } else {
        const fp = await freshProof(u.cookie);
        const auth = await Authenticator.create();
        const opt = await json(pcall("POST", "/api/passkeys/options", {}, u.cookie, fp));
        res = await pcall("POST", "/api/passkeys", { response: await auth.register(opt.options, OK) }, u.cookie, fp);
        if (kind === "remove-passkey") {
          expect(res.status).toBe(200);
          const c1 = cookieOf(res);
          const p1 = { "x-fz-unlock": (await res.json<{ unlock: string }>()).unlock };
          const id = (await db().prepare("SELECT id FROM passkeys WHERE user_id = ?").bind(u.id).first<{ id: number }>())!.id;
          res = await pcall("DELETE", `/api/passkeys/${id}`, undefined, c1, p1);
        }
      }
      expect(res.status).toBe(200);
      const body = await res.json<{ unlock: string; app_lock: boolean }>();
      const c2 = cookieOf(res);
      expect(await alive(c2)).toBe(200);
      expect(await subscribed(c2)).toBe(true);
      const n = await db().prepare("SELECT COUNT(*) AS n FROM push_subs WHERE user_id = ?").bind(u.id).first<{ n: number }>();
      expect(n!.n).toBe(1);
      expect(typeof body.unlock).toBe("string");
      expect(body.app_lock).toBe(false); // F28: the page keeps the lock off
    });
  }

  it("F47: the new session keeps the original check's time, so the chained proof expires with it", async () => {
    const u = await makeUser("achain");
    const fp = await freshProof(u.cookie, 4 * 60 * 1000);
    const res = await pcall("POST", "/api/me/backup-code", {}, u.cookie, fp);
    expect(res.status).toBe(200);
    const c2 = cookieOf(res);
    const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(decodeURIComponent(c2.slice(c2.indexOf("=") + 1)))))]
      .map((b) => b.toString(16).padStart(2, "0")).join("");
    const row = await db().prepare("SELECT unlocked_at, unlock_method FROM sessions WHERE token_hash = ?").bind(hash).first<{ unlocked_at: number; unlock_method: string }>();
    expect(row!.unlock_method).toBe("passkey");
    expect(Date.now() - row!.unlocked_at).toBeGreaterThanOrEqual(4 * 60 * 1000 - 50);
  });
});
