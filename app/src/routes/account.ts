// "Mi cuenta" for every person: devices and sessions, Face ID devices (passkeys), her own password,
// a new backup code, the Face ID lock, and deleting her account. Every id route checks ownership and
// answers 404 for anything that is not hers.
// Login-method changes (passkey added or removed, password set, new backup code) end ALL her sessions
// through triggers (migration 0003); the route then starts one new session for the device in use.
// Those changes, deleting the account and cancelling a reset link need a fresh check first (requireFresh: Face ID
// or the password in the last 5 minutes, even with the lock off; Melvin's decision, Nov 25 2026).
import { type Context, Hono } from "hono";
import { z } from "zod";
import type { RegistrationResponseJSON } from "@simplewebauthn/server";
import { generatePassphrase, hashPassphrase, hashPasswordKey, MAX_SESSION_MS, newSalt, PW_ITER, PW_KEY_RE } from "../lib/auth.ts";
import { idParam, notFound, readBody } from "../lib/http.ts";
import { challengeOf, checkRegistration, newHandle, RegistrationSchema, registrationOptions, saveChallenge, takeChallenge } from "../lib/passkeys.ts";
import { clearSessionCookie, deviceLabel, fail, limitIp, newSession } from "../lib/session.ts";
import { fakeSaltFor, PK_COUNTS, requireFresh } from "./auth.ts";
import { deleteSelf, RESET_WAIT_MS } from "./invites.ts";
import type { AppEnv } from "../types.ts";

export const accountRoutes = new Hono<AppEnv>();

/**
 * The session this device gets after a change that ends her sessions (a login-method change; its trigger runs
 * first in the batch). F47: it keeps the time and method of the real check, so one check never covers a chain of
 * changes past its 5 minutes. F29: this device's phone alerts move to the new session, so they keep working.
 * `writes` go LAST in the batch, after the change.
 */
async function rotateSession(c: Context<AppEnv>, db: D1Database, userId: number, now: number) {
  const old = c.get("session");
  const s = await newSession(c, db, userId, now, { unlock: old.proof?.method ?? null, unlockedAt: old.proof?.at ?? null });
  const subs = await db.prepare("SELECT endpoint, p256dh, auth, created_at, last_ok_at FROM push_subs WHERE user_id = ? AND session_hash = ?")
    .bind(userId, old.hash).all<{ endpoint: string; p256dh: string; auth: string; created_at: number; last_ok_at: number | null }>();
  const keep = subs.results.map((p) =>
    db.prepare(
      `INSERT INTO push_subs (user_id, session_hash, endpoint, p256dh, auth, created_at, last_ok_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (endpoint) DO UPDATE SET session_hash = excluded.session_hash WHERE push_subs.user_id = excluded.user_id`,
    ).bind(userId, s.hash, p.endpoint, p.p256dh, p.auth, p.created_at, p.last_ok_at));
  return { ...s, writes: [s.cleanup, s.stmt, ...keep] };
}

/** F28: the lock as it is after a change (removing the last Face ID turns it off), so the page never guesses. */
async function lockOf(db: D1Database, userId: number): Promise<boolean> {
  const r = await db.prepare("SELECT app_lock FROM users WHERE id = ?").bind(userId).first<{ app_lock: number }>();
  return r?.app_lock === 1;
}

accountRoutes.get("/account", async (c) => {
  const db = c.env.DB;
  const user = c.get("user");
  const now = Date.now();
  const [sessions, passkeys, me, resets] = await db.batch([
    db.prepare(
      `SELECT substr(token_hash, 1, 16) AS id, label, created_at, COALESCE(last_used_at, created_at) AS last_used, token_hash = ? AS current
       FROM sessions WHERE user_id = ? AND expires_at > ? AND created_at > ? ORDER BY last_used DESC`,
    ).bind(c.get("session").hash, user.id, now, now - MAX_SESSION_MS),
    // counts: 0 for a Face ID made before a backup-code sign-in, which no longer works (F07)
    db.prepare(
      `SELECT p.id, p.label, p.created_at, p.last_used_at, ${PK_COUNTS} AS counts FROM passkeys p JOIN users u ON u.id = p.user_id
       WHERE p.user_id = ? ORDER BY p.id`,
    ).bind(user.id),
    db.prepare("SELECT pw_hash IS NOT NULL AS has_password, app_lock, backup_used_at, created_at FROM users WHERE id = ?").bind(user.id),
    // Face ID reset links the owner made for her: she always sees them (made, used, cancelled, by whom), and nothing
    // in the app can hide them. (Whoever holds a reset link can add a Face ID to her account.)
    resetHistory(db, user.id),
  ]);
  const m = me.results[0] as { has_password: number; app_lock: number; backup_used_at: number | null; created_at: number };
  return c.json({
    sessions: (sessions.results as { current: number }[]).map((s) => ({ ...s, current: s.current === 1 })),
    passkeys: passkeys.results,
    has_password: m.has_password === 1,
    app_lock: m.app_lock === 1,
    backup_used_at: m.backup_used_at,
    resets: resets.results.map((r) => resetView(r as ResetRow, now)),
    is_owner: user.is_owner,
  });
});

export type ResetRow = { id: number; made_at: number; by: string; expires_at: number; used_at: number | null; cancelled_at: number | null; cancelled_by: string | null };

export function resetHistory(db: D1Database, userId: number, pendingOnly = false) {
  return db.prepare(
    `SELECT i.id, i.created_at AS made_at, o.display_name AS by, i.expires_at, i.used_at, i.cancelled_at, i.cancelled_by
     FROM invites i JOIN users o ON o.id = i.owner_id
     WHERE i.kind = 'reset' AND i.target_id = ?${pendingOnly ? " AND i.used_at IS NULL AND i.cancelled_at IS NULL AND i.expires_at > ?" : ""}
     ORDER BY i.id DESC LIMIT 10`,
  ).bind(...(pendingOnly ? [userId, Date.now()] : [userId]));
}

/** One reset link as she sees it: pending (with when it starts working), used, cancelled (by whom) or expired. */
export function resetView(r: ResetRow, now: number) {
  const status = r.used_at ? "used" : r.cancelled_at ? "cancelled" : r.expires_at <= now ? "expired" : "pending";
  return {
    id: r.id, by: r.by, made_at: r.made_at, usable_at: r.made_at + RESET_WAIT_MS, expires_at: r.expires_at,
    used_at: r.used_at, cancelled_at: r.cancelled_at, cancelled_by: r.cancelled_by, status,
  };
}

// Cancel a reset link made for her (it works only from 24 h after it was made, so she has that long to see it).
// Needs a fresh check, so someone holding her unlocked phone cannot quietly cancel a reset she asked for.
accountRoutes.delete("/me/resets/:id", async (c) => {
  const fresh = await requireFresh(c);
  if (fresh) return fresh;
  const id = idParam(c);
  const now = Date.now();
  const r = await c.env.DB
    .prepare(
      `UPDATE invites SET cancelled_at = ?, cancelled_by = 'self' WHERE id = ? AND kind = 'reset' AND target_id = ?
       AND used_at IS NULL AND cancelled_at IS NULL AND expires_at > ?`,
    )
    .bind(now, id, c.get("user").id, now)
    .run();
  if (!r.meta.changes) notFound();
  return c.json({ ok: true });
});

/** Sign out one device. The id is the first 16 hex characters of that session's hash (never the token). */
accountRoutes.delete("/sessions/:sid", async (c) => {
  const sid = c.req.param("sid");
  if (!/^[0-9a-f]{16}$/.test(sid)) notFound();
  const user = c.get("user");
  const r = await c.env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND substr(token_hash, 1, 16) = ?").bind(user.id, sid).run();
  if (!r.meta.changes) notFound();
  const current = c.get("session").hash.startsWith(sid);
  if (current) clearSessionCookie(c);
  return c.json({ ok: true, current });
});

// Add a Face ID device, step 1.
accountRoutes.post("/passkeys/options", async (c) => {
  const lim = await limitIp(c);
  if (lim) return lim;
  const fresh = await requireFresh(c);
  if (fresh) return fresh;
  const db = c.env.DB;
  const user = c.get("user");
  const [creds, me] = await db.batch([
    db.prepare("SELECT cred_id FROM passkeys WHERE user_id = ?").bind(user.id),
    db.prepare("SELECT passkey_handle FROM users WHERE id = ?").bind(user.id),
  ]);
  const handle = (me.results[0] as { passkey_handle: string | null }).passkey_handle ?? newHandle();
  const options = await registrationOptions(c, { username: user.username, displayName: user.display_name, handle },
    (creds.results as { cred_id: string }[]).map((r) => r.cred_id));
  await saveChallenge(db, options.challenge, "register", Date.now(), { userId: user.id, sessionHash: c.get("session").hash, data: { handle } });
  return c.json({ options });
});

// Add a Face ID device, step 2. Ends her other sessions (passkeys_added trigger); this device gets a new one.
accountRoutes.post("/passkeys", async (c) => {
  const lim = await limitIp(c);
  if (lim) return lim;
  const fresh = await requireFresh(c);
  if (fresh) return fresh;
  const db = c.env.DB;
  const now = Date.now();
  const user = c.get("user");
  const { response } = await readBody(c, z.object({ response: RegistrationSchema }));
  const challenge = challengeOf(response.response.clientDataJSON);
  const row = await takeChallenge(db, challenge, "register", now, { userId: user.id, sessionHash: c.get("session").hash });
  const { handle } = JSON.parse(row.data) as { handle: string };
  const cred = await checkRegistration(c, response as unknown as RegistrationResponseJSON, challenge);
  const s = await rotateSession(c, db, user.id, now);
  try {
    await db.batch([
      db.prepare("UPDATE users SET passkey_handle = COALESCE(passkey_handle, ?) WHERE id = ?").bind(handle, user.id),
      db.prepare(
        "INSERT INTO passkeys (user_id, cred_id, public_key, counter, transports, label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).bind(user.id, cred.credId, cred.publicKey, cred.counter, cred.transports, deviceLabel(c.req.header("user-agent")), now),
      ...s.writes,
    ]);
  } catch (e) {
    if (e instanceof Error && e.message.includes("passkeys.cred_id")) fail("bad_passkey");
    throw e;
  }
  s.setCookie();
  return c.json({ ok: true, unlock: s.unlock, app_lock: await lockOf(db, user.id) });
});

// Remove a Face ID device. Ends her other sessions; removing the last one also turns the lock off.
accountRoutes.delete("/passkeys/:id", async (c) => {
  const fresh = await requireFresh(c);
  if (fresh) return fresh;
  const db = c.env.DB;
  const id = idParam(c);
  const user = c.get("user");
  const now = Date.now();
  const exists = await db.prepare("SELECT 1 FROM passkeys WHERE id = ? AND user_id = ?").bind(id, user.id).first();
  if (!exists) notFound();
  const s = await rotateSession(c, db, user.id, now);
  await db.batch([
    db.prepare("DELETE FROM passkeys WHERE id = ? AND user_id = ?").bind(id, user.id),
    // Seguridad W3: the passkeys_last_removed trigger looks at every row, but a Face ID made before a backup-code
    // sign-in no longer works (F07). When the last one that works goes, the lock goes off too, so she is never
    // left with the lock on and no Face ID that can open it.
    db.prepare(
      `UPDATE users SET app_lock = 0 WHERE id = ?1 AND app_lock = 1
       AND NOT EXISTS (SELECT 1 FROM passkeys p JOIN users u ON u.id = p.user_id WHERE p.user_id = ?1 AND ${PK_COUNTS})`,
    ).bind(user.id),
    ...s.writes,
  ]);
  s.setCookie();
  return c.json({ ok: true, unlock: s.unlock, app_lock: await lockOf(db, user.id) });
});

// Her own password, step 1: the salt for the phone's PBKDF2 (her name's fixed salt, see fakeSaltFor).
accountRoutes.post("/me/password/salt", async (c) => c.json({ salt: await fakeSaltFor(c.env.DB, c.get("user").username), iter: PW_ITER }));

// Her own password, step 2: the PBKDF2 result. Ends her other sessions (users_login_changed_2).
accountRoutes.put("/me/password", async (c) => {
  const fresh = await requireFresh(c);
  if (fresh) return fresh;
  const db = c.env.DB;
  const now = Date.now();
  const user = c.get("user");
  const { salt, key } = await readBody(c, z.object({ salt: z.string().regex(/^[0-9a-f]{32}$/), key: z.string().regex(PW_KEY_RE) }));
  // Only her name's salt: a salt of the page's choice would change what /login/salt answers for her name.
  if (salt !== (await fakeSaltFor(db, user.username))) fail("invalid:salt");
  const s = await rotateSession(c, db, user.id, now);
  await db.batch([
    db.prepare("UPDATE users SET pw_salt = ?, pw_hash = ? WHERE id = ?").bind(salt, await hashPasswordKey(key, salt), user.id),
    ...s.writes,
  ]);
  s.setCookie();
  return c.json({ ok: true, unlock: s.unlock, app_lock: await lockOf(db, user.id) });
});

// A new backup code (shown once). The old one stops working and her other sessions end (users_login_changed).
accountRoutes.post("/me/backup-code", async (c) => {
  const fresh = await requireFresh(c);
  if (fresh) return fresh;
  const db = c.env.DB;
  const now = Date.now();
  const user = c.get("user");
  const code = generatePassphrase();
  const salt = newSalt();
  const s = await rotateSession(c, db, user.id, now);
  await db.batch([
    db.prepare("UPDATE users SET pass_salt = ?, pass_hash = ? WHERE id = ?").bind(salt, await hashPassphrase(code, salt), user.id),
    ...s.writes,
  ]);
  s.setCookie();
  return c.json({ ok: true, backup_code: code, unlock: s.unlock, app_lock: await lockOf(db, user.id) });
});

// Turn the Face ID lock off (needs the lock's proof like every other route). It is turned on only by
// POST /api/unlock {enable: true}, so it is never on without a Face ID that works. Turning it off needs a fresh
// check (Melvin, Nov 25 2026): the lock's own proof can be up to 12 hours old.
accountRoutes.put("/me/lock", async (c) => {
  await readBody(c, z.object({ on: z.literal(false) }));
  const fresh = await requireFresh(c);
  if (fresh) return fresh;
  await c.env.DB.prepare("UPDATE users SET app_lock = 0 WHERE id = ?").bind(c.get("user").id).run();
  return c.json({ ok: true, app_lock: false });
});

accountRoutes.delete("/me", async (c) => {
  if (c.get("user").is_owner) fail("owner_cannot_delete", 403);
  return (await requireFresh(c)) ?? deleteSelf(c);
});
