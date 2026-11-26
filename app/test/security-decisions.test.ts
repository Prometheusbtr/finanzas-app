// Melvin's decisions on the Cuentas review (Nov 25 2026), built by Seguridad on the Funciones branch:
// 1. A Face ID reset link works only from 24 h after it is made; making it ends nothing; she sees it on Home and in
//    Mi cuenta and can cancel it (with a fresh check); one open link per person; the history keeps everything.
// 2. A fresh check (Face ID, or the password for someone without one, in the last 5 minutes) before a new backup
//    code, a password, adding or removing a Face ID, deleting the account and cancelling a reset link, enforced on
//    the server even with the lock off. The password re-check counts on the same counters as sign-in.
//    Follow-up (Melvin, Nov 25 2026): also the owner making a reset link or removing a person, and turning the lock off.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../src/lib/auth.ts";
import { call, cookieOf, freshProof, json, login, makeUser, PASS, type TestUser } from "./helpers.ts";

const db = () => env.DB;
const DAY = 24 * 60 * 60 * 1000;
let ipN = 0;
const ip = () => `172.22.${(++ipN >> 8) & 255}.${ipN & 255}`;
const pcall = (method: string, path: string, body?: unknown, cookie?: string, headers: Record<string, string> = {}, at = ip()) =>
  call(method, path, body, cookie, { "cf-connecting-ip": at, ...headers });

async function makeOwner(): Promise<TestUser> {
  const u = await makeUser("dow");
  await db().prepare("UPDATE users SET is_owner = 1, display_name = 'Dueño' WHERE id = ?").bind(u.id).run();
  return u;
}
async function resetFor(owner: TestUser, m: TestUser) {
  const r = await pcall("POST", `/api/members/${m.id}/reset`, {}, owner.cookie, await freshProof(owner.cookie));
  expect(r.status).toBe(200);
  const j = await r.json<{ id: number; url: string; usable_at: number; expires_at: number }>();
  return { ...j, token: j.url.split("?c=")[1]! };
}
/** A Face ID on her account straight in the database (its trigger ends her sessions), and a new session. That
 * sign-in is with the passphrase, so it counts as the backup code: unless afterBackup, the Face ID is then dated
 * after it, as if she had added it again (a plain Face ID user). */
async function withPasskey(u: TestUser, afterBackup = false): Promise<TestUser> {
  const pk = await db().prepare("INSERT INTO passkeys (user_id, cred_id, public_key, counter, transports, label, created_at) VALUES (?, ?, 'AAAA', 0, '[]', 'x', 1) RETURNING id")
    .bind(u.id, `cred-${u.id}-${Math.random().toString(36).slice(2)}`).first<{ id: number }>();
  const r = await login(u.username, PASS, ip());
  expect(r.status).toBe(200);
  if (!afterBackup) await db().prepare("UPDATE passkeys SET created_at = ? WHERE id = ?").bind(Date.now() + 60_000, pk!.id).run();
  return { ...u, cookie: cookieOf(r) };
}

describe("decision 1: Face ID reset links wait 24 hours", () => {
  it("making one ends nothing; in its first 24 h it only says from when it works, and the database refuses its use", async () => {
    const owner = await makeOwner();
    const m = await makeUser("drs");
    const link = await resetFor(owner, m);
    expect(link.usable_at - Date.now()).toBeGreaterThan(DAY - 60_000);
    expect(link.expires_at - link.usable_at).toBe(2 * DAY);
    expect((await call("GET", "/api/bootstrap", undefined, m.cookie)).status).toBe(200); // her session still works
    const info = await json(pcall("POST", "/api/reset", { token: link.token }));
    expect(info).toEqual({ pending: true, usable_at: link.usable_at }); // no name before it works
    const opt = await pcall("POST", "/api/reset/options", { token: link.token });
    expect(opt.status).toBe(409);
    expect(await opt.json()).toEqual({ error: "reset_not_yet", usable_at: link.usable_at });
    await expect(db().prepare("UPDATE invites SET used_at = ? WHERE id = ?").bind(Date.now(), link.id).run()).rejects.toThrow(/invite_closed/);
    // 24 h later it works
    await db().prepare("UPDATE invites SET created_at = created_at - ? WHERE id = ?").bind(DAY + 60_000, link.id).run();
    expect((await json(pcall("POST", "/api/reset", { token: link.token }))).username).toBe(m.username);
    expect((await pcall("POST", "/api/reset/options", { token: link.token })).status).toBe(200);
  });

  it("she sees it on Home (bootstrap) and in Mi cuenta, the owner sees from when it works, and she can cancel it", async () => {
    const owner = await makeOwner();
    const m = await makeUser("drc");
    const link = await resetFor(owner, m);
    const boot = await json(call("GET", "/api/bootstrap", undefined, m.cookie));
    expect(boot.reset_pending).toEqual([expect.objectContaining({ id: link.id, by: "Dueño", usable_at: link.usable_at, status: "pending" })]);
    const members = await json(call("GET", "/api/members", undefined, owner.cookie));
    expect(members.invites.find((i: { id: number }) => i.id === link.id)).toMatchObject({ kind: "reset", usable_at: link.usable_at });
    // cancelling needs a fresh check: none, or one older than 5 minutes, is refused
    const none = await pcall("DELETE", `/api/me/resets/${link.id}`, {}, m.cookie);
    expect(none.status).toBe(403);
    expect(await none.json()).toEqual({ error: "reauth", method: "passphrase" });
    expect((await pcall("DELETE", `/api/me/resets/${link.id}`, {}, m.cookie, await freshProof(m.cookie, 6 * 60_000))).status).toBe(403);
    // someone else, even with a fresh check, gets 404 and the link stays
    const bob = await makeUser("drb");
    expect((await pcall("DELETE", `/api/me/resets/${link.id}`, {}, bob.cookie, await freshProof(bob.cookie))).status).toBe(404);
    expect((await pcall("DELETE", `/api/me/resets/${link.id}`, {}, owner.cookie, await freshProof(owner.cookie))).status).toBe(404);
    expect((await json(call("GET", "/api/bootstrap", undefined, m.cookie))).reset_pending).toHaveLength(1);
    // she cancels it
    expect((await pcall("DELETE", `/api/me/resets/${link.id}`, {}, m.cookie, await freshProof(m.cookie))).status).toBe(200);
    expect((await pcall("POST", "/api/reset", { token: link.token })).status).toBe(404);
    expect((await json(call("GET", "/api/bootstrap", undefined, m.cookie))).reset_pending).toEqual([]);
    expect((await json(call("GET", "/api/account", undefined, m.cookie))).resets)
      .toEqual([expect.objectContaining({ id: link.id, status: "cancelled", cancelled_by: "self", by: "Dueño" })]);
    expect((await json(call("GET", "/api/members", undefined, owner.cookie))).invites.some((i: { id: number }) => i.id === link.id)).toBe(false);
    expect((await pcall("DELETE", `/api/me/resets/${link.id}`, {}, m.cookie, await freshProof(m.cookie))).status).toBe(404);
  });

  it("one open link per person: a new one replaces the older, and the history shows both", async () => {
    const owner = await makeOwner();
    const m = await makeUser("drn");
    const first = await resetFor(owner, m);
    const second = await resetFor(owner, m);
    expect((await pcall("POST", "/api/reset", { token: first.token })).status).toBe(404);
    const boot = await json(call("GET", "/api/bootstrap", undefined, m.cookie));
    expect(boot.reset_pending.map((r: { id: number }) => r.id)).toEqual([second.id]);
    const hist = (await json(call("GET", "/api/account", undefined, m.cookie))).resets;
    expect(hist.map((r: { id: number; status: string; cancelled_by: string | null }) => [r.id, r.status, r.cancelled_by]))
      .toEqual([[second.id, "pending", null], [first.id, "cancelled", "replaced"]]);
    expect(JSON.stringify(hist)).not.toContain(second.token);
    expect(JSON.stringify(hist)).not.toContain(await sha256Hex(second.token));
  });
});

describe("decision 2: a fresh check before sensitive changes, on the server, even with the lock off", () => {
  it("every sensitive route refuses without a proof from the last 5 minutes", async () => {
    const owner = await makeOwner();
    const m = await makeUser("dfr");
    const link = await resetFor(owner, m);
    const { salt } = await json(pcall("POST", "/api/me/password/salt", {}, m.cookie));
    const pk = await db().prepare("INSERT INTO passkeys (user_id, cred_id, public_key, counter, transports, label, created_at) VALUES (?, ?, 'AAAA', 0, '[]', 'x', 1) RETURNING id")
      .bind(m.id, `cred-dfr-${m.id}`).first<{ id: number }>();
    const u = { ...m, cookie: cookieOf(await login(m.username, PASS, ip())) }; // the passkey ended the first session
    await db().prepare("UPDATE passkeys SET created_at = ? WHERE id = ?").bind(Date.now() + 60_000, pk!.id).run(); // a plain Face ID user
    const routes: [string, string, unknown][] = [
      ["POST", "/api/me/backup-code", {}],
      ["PUT", "/api/me/password", { salt, key: "ab".repeat(32) }],
      ["POST", "/api/passkeys/options", {}],
      ["POST", "/api/passkeys", { response: {} }],
      ["DELETE", `/api/passkeys/${pk!.id}`, {}],
      ["DELETE", "/api/me", { confirm: m.username }],
      ["DELETE", `/api/me/resets/${link.id}`, {}],
    ];
    const stale = await freshProof(u.cookie, 5 * 60_000 + 1000);
    for (const [method, path, body] of routes) {
      const r = await pcall(method, path, body, u.cookie);
      expect(r.status, `${method} ${path}`).toBe(403);
      expect(await r.json()).toEqual({ error: "reauth", method: "passkey" });
      expect((await pcall(method, path, body, u.cookie, stale)).status, `${method} ${path} stale`).toBe(403);
      expect((await pcall(method, path, body, u.cookie, { "x-fz-unlock": "made-up" })).status, `${method} ${path} wrong`).toBe(403);
    }
    // nothing changed
    expect(await db().prepare("SELECT 1 FROM passkeys WHERE id = ?").bind(pk!.id).first()).not.toBeNull();
    expect(await db().prepare("SELECT pw_hash FROM users WHERE id = ?").bind(m.id).first()).toEqual({ pw_hash: null });
    expect((await json(call("GET", "/api/bootstrap", undefined, u.cookie))).reset_pending).toHaveLength(1);
    // with a fresh one they work (the new backup code, then the deletion with the proof its new session got)
    const code = await pcall("POST", "/api/me/backup-code", {}, u.cookie, await freshProof(u.cookie));
    expect(code.status).toBe(200);
    const next = await code.json<{ unlock: string }>();
    const del = await pcall("DELETE", "/api/me", { confirm: m.username }, cookieOf(code), { "x-fz-unlock": next.unlock });
    expect(del.status).toBe(200);
  });

  it("without a Face ID the check is the passphrase or the password again, on the same counters as sign-in", async () => {
    const u = await makeUser("dpw");
    const at = ip();
    const wrong = await pcall("POST", "/api/reauth", { passphrase: "wrong-words" }, u.cookie, {}, at);
    expect(wrong.status).toBe(403);
    expect(await wrong.json()).toEqual({ error: "bad_password", tries_left: 4 });
    expect((await pcall("POST", "/api/reauth", { key: "ab".repeat(32) }, u.cookie, {}, at)).status).toBe(400); // she has no password
    const ok = await pcall("POST", "/api/reauth", { passphrase: PASS }, u.cookie, {}, at);
    expect(ok.status).toBe(200);
    const { unlock } = await ok.json<{ unlock: string }>();
    expect((await pcall("POST", "/api/me/backup-code", {}, u.cookie, { "x-fz-unlock": unlock })).status).toBe(200);
    // the counter is login's: 3 wrong re-checks and 2 wrong sign-ins lock both for this name and address
    const v = await makeUser("dpl");
    const at2 = ip();
    for (let i = 0; i < 3; i++) expect((await pcall("POST", "/api/reauth", { passphrase: "nope" }, v.cookie, {}, at2)).status).toBe(403);
    expect((await login(v.username, "nope", at2)).status).toBe(401);
    expect((await login(v.username, "nope", at2)).status).toBe(429);
    expect((await pcall("POST", "/api/reauth", { passphrase: PASS }, v.cookie, {}, at2)).status).toBe(429);
    expect((await login(v.username, PASS, at2)).status).toBe(429);
  });

  it("someone with a password uses it (never the backup code); someone with a Face ID uses Face ID", async () => {
    const u = await makeUser("dkp");
    const { salt } = await json(pcall("POST", "/api/me/password/salt", {}, u.cookie));
    const set = await pcall("PUT", "/api/me/password", { salt, key: "cd".repeat(32) }, u.cookie, await freshProof(u.cookie));
    expect(set.status).toBe(200);
    const c2 = cookieOf(set);
    expect((await pcall("DELETE", "/api/me", { confirm: u.username }, c2)).status).toBe(403);
    expect((await json(pcall("DELETE", "/api/me", { confirm: u.username }, c2))).method).toBe("password");
    expect((await pcall("POST", "/api/reauth", { passphrase: PASS }, c2)).status).toBe(400);
    expect((await pcall("POST", "/api/reauth", { key: "ab".repeat(32) }, c2)).status).toBe(403);
    const ok = await json(pcall("POST", "/api/reauth", { key: "cd".repeat(32) }, c2));
    expect(ok.unlock).toEqual(expect.any(String));
    const f = await withPasskey(await makeUser("dfk"));
    expect((await pcall("POST", "/api/reauth", { passphrase: PASS }, f.cookie)).status).toBe(409);
  });

  it("after the backup code the page has a fresh proof, so she can add a Face ID again", async () => {
    const u = await withPasskey(await makeUser("dbk"), true);
    const r = await login(u.username, PASS, ip()); // with a Face ID on the account the passphrase is her backup code
    const body = await r.json<{ backup_used: boolean; fresh: string }>();
    expect(body.backup_used).toBe(true);
    expect((await pcall("POST", "/api/passkeys/options", {}, cookieOf(r), { "x-fz-unlock": body.fresh })).status).toBe(200);
    // once those 5 minutes are gone, the check is the backup code again (her lost Face ID cannot do it)
    const late = await pcall("POST", "/api/passkeys/options", {}, cookieOf(r));
    expect(late.status).toBe(403);
    expect(await late.json()).toEqual({ error: "reauth", method: "passphrase" });
    const again = await json(pcall("POST", "/api/reauth", { passphrase: PASS }, cookieOf(r)));
    expect((await pcall("POST", "/api/passkeys/options", {}, cookieOf(r), { "x-fz-unlock": again.unlock })).status).toBe(200);
  });

  it("Melvin's follow-up: making a reset link, removing a person and turning the lock off need it too", async () => {
    const owner = await makeOwner();
    const m = await makeUser("dfx");
    const routes: [string, string, unknown][] = [
      ["POST", `/api/members/${m.id}/reset`, {}],
      ["DELETE", `/api/members/${m.id}`, { confirm: m.username }],
      ["PUT", "/api/me/lock", { on: false }],
    ];
    const stale = await freshProof(owner.cookie, 5 * 60_000 + 1000);
    for (const [method, path, body] of routes) {
      const r = await pcall(method, path, body, owner.cookie);
      expect(r.status, `${method} ${path}`).toBe(403);
      expect(await r.json()).toEqual({ error: "reauth", method: "passphrase" });
      expect((await pcall(method, path, body, owner.cookie, stale)).status, `${method} ${path} stale`).toBe(403);
      expect((await pcall(method, path, body, owner.cookie, { "x-fz-unlock": "made-up" })).status, `${method} ${path} wrong`).toBe(403);
    }
    // nothing changed: no link, the person is still there
    expect(await db().prepare("SELECT count(*) n FROM invites WHERE kind = 'reset' AND target_id = ?").bind(m.id).first()).toEqual({ n: 0 });
    expect(await db().prepare("SELECT 1 FROM users WHERE id = ?").bind(m.id).first()).not.toBeNull();
    // a wrong typed name still says so first, without asking for the check
    expect((await pcall("DELETE", `/api/members/${m.id}`, { confirm: "someone-else" }, owner.cookie)).status).toBe(400);
    // with a fresh check each one works
    expect((await pcall("POST", `/api/members/${m.id}/reset`, {}, owner.cookie, await freshProof(owner.cookie))).status).toBe(200);
    expect((await pcall("PUT", "/api/me/lock", { on: false }, owner.cookie, await freshProof(owner.cookie))).status).toBe(200);
    expect((await pcall("DELETE", `/api/members/${m.id}`, { confirm: m.username }, owner.cookie, await freshProof(owner.cookie))).status).toBe(200);
    expect(await db().prepare("SELECT 1 FROM users WHERE id = ?").bind(m.id).first()).toBeNull();
  });

  it("Melvin's follow-up: the old answers come before the check (no reauth prompt for a request that would fail anyway)", async () => {
    const owner = await makeOwner();
    const m = await makeUser("dfo");
    const other = await makeUser("dfn");
    const cases: [string, string, unknown, string, number, string][] = [
      // a non-owner, even for a real person
      ["POST", `/api/members/${m.id}/reset`, {}, other.cookie, 403, "owner_only"],
      ["DELETE", `/api/members/${m.id}`, { confirm: m.username }, other.cookie, 403, "owner_only"],
      // nobody with that id, or a bad id
      ["POST", "/api/members/999999/reset", {}, owner.cookie, 404, "not_found"],
      ["DELETE", "/api/members/999999", { confirm: m.username }, owner.cookie, 404, "not_found"],
      ["POST", "/api/members/x/reset", {}, owner.cookie, 404, "not_found"],
      // the owner himself
      ["POST", `/api/members/${owner.id}/reset`, {}, owner.cookie, 403, "owner_self"],
      ["DELETE", `/api/members/${owner.id}`, { confirm: owner.username }, owner.cookie, 403, "owner_self"],
      // a body the route never takes
      ["DELETE", `/api/members/${m.id}`, {}, owner.cookie, 400, "invalid:"],
      ["PUT", "/api/me/lock", { on: true }, owner.cookie, 400, "invalid:"],
    ];
    for (const [method, path, body, cookie, status, error] of cases) {
      const r = await pcall(method, path, body, cookie);
      expect(r.status, `${method} ${path}`).toBe(status);
      const j = await r.json<{ error: string }>();
      expect(j.error, `${method} ${path}`).not.toBe("reauth");
      expect(j.error.startsWith(error), `${method} ${path}: ${j.error}`).toBe(true);
    }
    expect(await db().prepare("SELECT count(*) n FROM invites WHERE kind = 'reset' AND target_id IN (?, ?)").bind(m.id, owner.id).first())
      .toEqual({ n: 0 });
  });
});
