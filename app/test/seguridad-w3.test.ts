// Seguridad review of Wave 3 (sign-in and sessions, Nov 25 2026):
// 1. Removing the last Face ID that still works turns the lock off, even when older Face IDs (made before a
//    backup-code sign-in, which no longer work) are still listed. Before, the lock stayed on with nothing to open it.
// 2. A session from before migration 0006 (proof with no method) still opens the lock but is never fresh.
// 3. A password proof carried into the new session after adding a Face ID is no longer fresh: the next sensitive
//    change asks for Face ID (no chain from password to Face ID-only changes).
// 4. The push move on a session change never brings back a subscription she turned off and never touches another
//    person's row.
// (The page side, signing out ends this browser's push subscription so keepPush never re-sends it for the next
// person, is in js/screens/alertas.js hooks.dropPush; a headless browser has no push, so attack.sh cannot run it.)
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { call, cookieOf, freshProof, json, makeUser } from "./helpers.ts";
import { Authenticator, type Opts } from "./webauthn.ts";

const db = () => env.DB;
const OK: Opts = { origin: env.APP_ORIGIN, rpId: env.RP_ID };
const KEY = "cd".repeat(32);
let ipN = 0;
const freshIp = () => `172.43.${(++ipN >> 8) & 255}.${ipN & 255}`;
const pcall = (method: string, path: string, body?: unknown, cookie?: string, headers: Record<string, string> = {}) =>
  call(method, path, body, cookie, { "cf-connecting-ip": freshIp(), ...headers });
const hex = async (s: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))]
  .map((b) => b.toString(16).padStart(2, "0")).join("");
const hashOf = (cookie: string) => hex(decodeURIComponent(cookie.slice(cookie.indexOf("=") + 1)));

let nameN = 0;
async function member() {
  const owner = await makeUser("sw3own");
  await db().prepare("UPDATE users SET is_owner = 1 WHERE id = ?").bind(owner.id).run();
  const inv = await json(pcall("POST", "/api/invites", {}, owner.cookie));
  const token = inv.url.split("?c=")[1];
  const username = `sw3m${++nameN}${Math.random().toString(36).slice(2, 6)}`;
  const opt = await json(pcall("POST", "/api/signup/options", { token, username, display_name: "Person B", lang: "es" }));
  const auth = await Authenticator.create();
  const res = await pcall("POST", "/api/signup", { token, response: await auth.register(opt.options, OK) });
  expect(res.status).toBe(200);
  const { backup_code } = await res.clone().json<{ backup_code: string }>();
  const id = (await db().prepare("SELECT id FROM users WHERE username = ?").bind(username).first<{ id: number }>())!.id;
  return { id, username, auth, cookie: cookieOf(res), backup: backup_code };
}
async function addPasskey(cookie: string, proof: Record<string, string>) {
  const auth = await Authenticator.create();
  const opt = await json(pcall("POST", "/api/passkeys/options", {}, cookie, proof));
  const r = await pcall("POST", "/api/passkeys", { response: await auth.register(opt.options, OK) }, cookie, proof);
  expect(r.status).toBe(200);
  return { auth, cookie: cookieOf(r), body: await r.json<{ unlock: string; app_lock: boolean }>() };
}
async function subscribe(cookie: string, tag: string) {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const p256dh = btoa(String.fromCharCode(...new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const endpoint = `https://fcm.googleapis.com/fcm/send/sw3-${tag}`;
  const r = await call("POST", "/api/push/subscription", { endpoint, keys: { p256dh, auth: "AAAAAAAAAAAAAAAAAAAAAA" } }, cookie);
  expect(r.status).toBe(201);
  return endpoint;
}

describe("Seguridad W3: the lock and Face IDs that no longer work", () => {
  it("removing the last Face ID that works turns the lock off, though the old (lost) one is still listed", async () => {
    const m = await member();
    // lost phone: backup-code sign-in (lock off, the first Face ID stops working)
    const rec = await pcall("POST", "/api/login", { username: m.username, passphrase: m.backup });
    expect(rec.status).toBe(200);
    const hp = { "x-fz-unlock": (await rec.clone().json<{ fresh: string }>()).fresh };
    const p2 = await addPasskey(cookieOf(rec), hp);
    // lock on with the new Face ID
    const o = await json(pcall("POST", "/api/unlock/options", {}, p2.cookie, { "x-fz-unlock": p2.body.unlock }));
    const on = await pcall("POST", "/api/unlock", { response: await p2.auth.authenticate(o.options, OK), enable: true }, p2.cookie,
      { "x-fz-unlock": p2.body.unlock });
    expect(on.status).toBe(200);
    const lockProof = { "x-fz-unlock": (await on.json<{ unlock: string }>()).unlock };
    const newId = (await db().prepare("SELECT id FROM passkeys WHERE user_id = ? ORDER BY id DESC").bind(m.id).first<{ id: number }>())!.id;
    const del = await pcall("DELETE", `/api/passkeys/${newId}`, undefined, p2.cookie, lockProof);
    expect(del.status).toBe(200);
    expect((await del.json<{ app_lock: boolean }>()).app_lock).toBe(false);
    const u = await db().prepare("SELECT app_lock, (SELECT COUNT(*) FROM passkeys WHERE user_id = ?1) AS n FROM users WHERE id = ?1")
      .bind(m.id).first<{ app_lock: number; n: number }>();
    expect(u).toEqual({ app_lock: 0, n: 1 }); // the old one is still listed (stale), the lock is off
  });

  it("removing one of two working Face IDs keeps the lock on", async () => {
    const m = await member();
    const fp = await freshProof(m.cookie);
    const p2 = await addPasskey(m.cookie, fp);
    const o = await json(pcall("POST", "/api/unlock/options", {}, p2.cookie, { "x-fz-unlock": p2.body.unlock }));
    const on = await pcall("POST", "/api/unlock", { response: await p2.auth.authenticate(o.options, OK), enable: true }, p2.cookie,
      { "x-fz-unlock": p2.body.unlock });
    const lockProof = { "x-fz-unlock": (await on.json<{ unlock: string }>()).unlock };
    const firstId = (await db().prepare("SELECT id FROM passkeys WHERE user_id = ? ORDER BY id").bind(m.id).first<{ id: number }>())!.id;
    const del = await pcall("DELETE", `/api/passkeys/${firstId}`, undefined, p2.cookie, lockProof);
    expect(del.status).toBe(200);
    expect((await del.json<{ app_lock: boolean }>()).app_lock).toBe(true);
  });
});

describe("Seguridad W3: proofs and their method", () => {
  it("a session from before migration 0006 (proof, no method) opens the lock but is not fresh", async () => {
    const m = await member();
    await db().prepare("UPDATE users SET app_lock = 1 WHERE id = ?").bind(m.id).run();
    const proof = await freshProof(m.cookie);
    await db().prepare("UPDATE sessions SET unlock_method = NULL WHERE token_hash = ?").bind(await hashOf(m.cookie)).run();
    expect((await call("GET", "/api/bootstrap", undefined, m.cookie, proof)).status).toBe(200);
    const r = await pcall("POST", "/api/me/backup-code", {}, m.cookie, proof);
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: "reauth", method: "passkey" });
  });

  it("a password proof carried past adding a Face ID is no longer fresh: the next change asks for Face ID", async () => {
    const u = await makeUser("sw3pw");
    const added = await addPasskey(u.cookie, await freshProof(u.cookie, 0, "password"));
    const row = await db().prepare("SELECT unlock_method FROM sessions WHERE token_hash = ?").bind(await hashOf(added.cookie))
      .first<{ unlock_method: string }>();
    expect(row!.unlock_method).toBe("password");
    const r = await pcall("POST", "/api/me/backup-code", {}, added.cookie, { "x-fz-unlock": added.body.unlock });
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: "reauth", method: "passkey" });
  });
});

describe("Seguridad W3: the push move on a session change", () => {
  it("never brings back a subscription she turned off, and never touches another person's row", async () => {
    const a = await makeUser("sw3pa");
    const b = await makeUser("sw3pb");
    await subscribe(a.cookie, `a-${a.id}`);
    const eb = await subscribe(b.cookie, `b-${b.id}`);
    const bRow = await db().prepare("SELECT user_id, session_hash FROM push_subs WHERE endpoint = ?").bind(eb).first();
    expect((await call("DELETE", "/api/push/subscription", undefined, a.cookie)).status).toBe(200);
    const res = await pcall("POST", "/api/me/backup-code", {}, a.cookie, await freshProof(a.cookie));
    expect(res.status).toBe(200);
    const n = await db().prepare("SELECT COUNT(*) AS n FROM push_subs WHERE user_id = ?").bind(a.id).first<{ n: number }>();
    expect(n!.n).toBe(0);
    expect(await db().prepare("SELECT user_id, session_hash FROM push_subs WHERE endpoint = ?").bind(eb).first()).toEqual(bRow);
  });

  it("the old session's row is gone and the new session's row is the only one (the move runs after the cascade)", async () => {
    const a = await makeUser("sw3pc");
    const e = await subscribe(a.cookie, `c-${a.id}`);
    const old = await hashOf(a.cookie);
    const { salt } = await json(pcall("POST", "/api/me/password/salt", {}, a.cookie));
    const res = await pcall("PUT", "/api/me/password", { salt, key: KEY }, a.cookie, await freshProof(a.cookie));
    expect(res.status).toBe(200);
    const rows = await db().prepare("SELECT session_hash FROM push_subs WHERE endpoint = ?").bind(e).all<{ session_hash: string }>();
    expect(rows.results.map((r) => r.session_hash)).toEqual([await hashOf(cookieOf(res))]);
    expect(await db().prepare("SELECT 1 FROM sessions WHERE token_hash = ?").bind(old).first()).toBeNull();
  });
});
