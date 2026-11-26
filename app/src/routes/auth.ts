import { Hono, type Context, type MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import {
  fakeSalt, hashPassphrase, hashPasswordKey, LOCK_MS, MAX_FAILURES, MAX_SESSION_MS, nameKey,
  normalizeUsername, PW_ITER, PW_KEY_RE, renewedExpiry, sameHex, sha256Hex, windowState,
} from "../lib/auth.ts";
import { idParam, notFound, readBody } from "../lib/http.ts";
import {
  AuthenticationSchema, authenticationOptions, challengeOf, checkAuthentication, saveChallenge, takeChallenge, type PasskeyRow,
} from "../lib/passkeys.ts";
import {
  clearSessionCookie, clientIp, countTry, type Counter, fail, FRESH_MS, limitIp, newSession, newUnlock, readSessionToken,
  setSessionCookie, tooMany, UNLOCK_MS,
} from "../lib/session.ts";
import type { AppEnv, User } from "../types.ts";

const HOUR = 60 * 60 * 1000;
const NO_SALT = "0".repeat(32);

const LoginSchema = z.object({
  username: z.string().min(1).max(64),
  passphrase: z.string().min(1).max(200),
});

/** M1, step 1: every request from this IP counts, even a broken one (one counter for every way in). */
const ipGate = limitIp;

/** M1, step 2: count the try for this username from this IP before looking at what was typed. */
async function nameGate(c: Context<AppEnv>, uname: string) {
  const nKey = await nameKey(uname, clientIp(c));
  const count = (await countTry(c.env.DB, nKey, Date.now(), LOCK_MS).first<Counter>())!;
  const state = windowState(count.tries, count.window_start, Date.now(), MAX_FAILURES, LOCK_MS);
  return { nKey, state, res: state.allowed ? null : tooMany(c, "locked", state.retryAfterS) };
}

function badLogin(c: Context<AppEnv>, state: ReturnType<typeof windowState>) {
  if (state.last) return tooMany(c, "locked", state.retryAfterS);
  return c.json({ error: "bad_login", tries_left: state.triesLeft }, 401);
}

/** Routes that work without a session. */
export const publicRoutes = new Hono<AppEnv>();

// The passphrase. For someone who also has Face ID or her own password, the passphrase is her backup code:
// using it ends all her sessions (the users_login_changed_2 trigger), turns the Face ID lock off and asks for a
// new Face ID setup. For someone with only a passphrase (Melvin today) nothing changes.
publicRoutes.post("/login", async (c) => {
  const db = c.env.DB;
  const now = Date.now();
  const ipRes = await ipGate(c);
  if (ipRes) return ipRes;

  const { username, passphrase } = await readBody(c, LoginSchema);
  const uname = normalizeUsername(username);
  const { nKey, state, res } = await nameGate(c, uname);
  if (res) return res;

  const user = await db
    .prepare(
      `SELECT id, pass_salt, pass_hash, (pw_hash IS NOT NULL OR EXISTS (SELECT 1 FROM passkeys p WHERE p.user_id = users.id)) AS other
       FROM users WHERE username = ?`,
    )
    .bind(uname)
    .first<{ id: number; pass_salt: string; pass_hash: string; other: number }>();
  // Hash even for unknown names so both cases take the same time and look the same.
  const hash = await hashPassphrase(passphrase, user?.pass_salt ?? NO_SALT);
  if (!user || !sameHex(hash, user.pass_hash)) return badLogin(c, state);

  const backup = user.other === 1;
  // After the backup code she adds a Face ID again, which needs a fresh check: the code she just typed is one, so
  // the page gets a proof for the next 5 minutes (the lock itself is off from here).
  const s = await newSession(c, db, user.id, now, { unlock: backup ? "passphrase" : null });
  await db.batch([
    db.prepare("DELETE FROM login_limits WHERE k = ?").bind(nKey),
    s.cleanup,
    ...(backup ? [db.prepare("UPDATE users SET backup_used_at = ?, app_lock = 0 WHERE id = ?").bind(now, user.id)] : []),
    s.stmt,
  ]);
  s.setCookie();
  return c.json(backup ? { ok: true, backup_used: true, fresh: s.unlock } : { ok: true });
});

/**
 * The password salt for a username: HMAC of the name with the server's key (app_keys, never sent anywhere).
 * Every password gets this salt (sign-up and Mi cuenta), and a name without a password gets the same value,
 * so the salt answer for a name never changes, whether or not it exists or has a password.
 * No key, no answer: an empty key would make every made-up salt computable by anyone.
 */
export async function fakeSaltFor(db: D1Database, uname: string): Promise<string> {
  const k = await db.prepare("SELECT value FROM app_keys WHERE name = 'fake_salt'").first<{ value: string }>();
  if (!k || !/^[0-9a-f]{64}$/.test(k.value)) throw new Error("app_keys.fake_salt missing");
  return fakeSalt(k.value, uname);
}

// Her own password, step 1: the salt for the phone's PBKDF2. A name without a password gets a made-up salt
// that is the same every time, so this answer says nothing about who has an account.
publicRoutes.post("/login/salt", async (c) => {
  const lim = await limitIp(c);
  if (lim) return lim;
  const { username } = await readBody(c, z.object({ username: z.string().min(1).max(64) }));
  const uname = normalizeUsername(username);
  const fake = await fakeSaltFor(c.env.DB, uname);
  const row = await c.env.DB.prepare("SELECT pw_salt FROM users WHERE username = ? AND pw_hash IS NOT NULL").bind(uname)
    .first<{ pw_salt: string }>();
  return c.json({ salt: row?.pw_salt ?? fake, iter: PW_ITER });
});

// Her own password, step 2: the PBKDF2 result. Same M1 counters as the passphrase (per IP, and per name and IP).
publicRoutes.post("/login/password", async (c) => {
  const db = c.env.DB;
  const now = Date.now();
  const ipRes = await ipGate(c);
  if (ipRes) return ipRes;
  const { username, key } = await readBody(c, z.object({ username: z.string().min(1).max(64), key: z.string().regex(PW_KEY_RE) }));
  const uname = normalizeUsername(username);
  const { nKey, state, res } = await nameGate(c, uname);
  if (res) return res;

  const user = await db.prepare("SELECT id, pw_salt, pw_hash, app_lock FROM users WHERE username = ?").bind(uname)
    .first<{ id: number; pw_salt: string | null; pw_hash: string | null; app_lock: number }>();
  const hash = await hashPasswordKey(key, user?.pw_salt ?? NO_SALT);
  if (!user || !user.pw_hash || !sameHex(hash, user.pw_hash)) return badLogin(c, state);

  // A password sign-in opens the Face ID lock for this page. Its proof says "password", so for someone with a Face
  // ID it is not the fresh check the sensitive changes need (F06): those still ask for Face ID.
  const s = await newSession(c, db, user.id, now, { unlock: user.app_lock === 1 ? "password" : null });
  await db.batch([db.prepare("DELETE FROM login_limits WHERE k = ?").bind(nKey), s.cleanup, s.stmt]);
  s.setCookie();
  return c.json({ ok: true, ...(s.unlock ? { unlock: s.unlock } : {}) });
});

// Face ID sign-in, no username typed: the phone offers the passkeys it holds for this site.
publicRoutes.post("/login/passkey/options", async (c) => {
  const lim = await limitIp(c);
  if (lim) return lim;
  const options = await authenticationOptions(c, []);
  await saveChallenge(c.env.DB, options.challenge, "login", Date.now());
  return c.json({ options });
});

type LoginPasskey = PasskeyRow & { passkey_handle: string | null; app_lock: number };

/**
 * F07, Melvin's decision (Nov 25 2026): after a sign-in with the backup code, the Face IDs made before it stop
 * completely (the backup code is for a lost phone). For SQL with passkeys as p and users as u.
 */
export const PK_COUNTS = "(u.backup_used_at IS NULL OR p.created_at > u.backup_used_at)";

publicRoutes.post("/login/passkey", async (c) => {
  const db = c.env.DB;
  const now = Date.now();
  const lim = await limitIp(c);
  if (lim) return lim;
  const { response } = await readBody(c, z.object({ response: AuthenticationSchema }));
  const challenge = challengeOf(response.response.clientDataJSON);
  await takeChallenge(db, challenge, "login", now);
  const pk = await db
    .prepare(
      `SELECT p.id, p.user_id, p.cred_id, p.public_key, p.counter, p.transports, u.passkey_handle, u.app_lock
       FROM passkeys p JOIN users u ON u.id = p.user_id WHERE p.cred_id = ? AND ${PK_COUNTS}`,
    )
    .bind(response.id)
    .first<LoginPasskey>();
  if (!pk) fail("bad_passkey");
  if (response.response.userHandle !== undefined && response.response.userHandle !== pk.passkey_handle) fail("bad_passkey");
  const counter = await checkAuthentication(c, response as unknown as AuthenticationResponseJSON, challenge, pk);
  // Face ID was just checked, so the lock (when on) starts open for this page.
  const s = await newSession(c, db, pk.user_id, now, { unlock: pk.app_lock === 1 ? "passkey" : null });
  await db.batch([
    db.prepare("UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?").bind(counter, now, pk.id),
    s.cleanup,
    s.stmt,
  ]);
  s.setCookie();
  return c.json({ ok: true, ...(s.unlock ? { unlock: s.unlock } : {}) });
});

type SessionRow = Omit<User, "is_owner"> & {
  is_owner: number; created_at: number; expires_at: number; last_used_at: number | null;
  unlock_hash: string | null; unlocked_at: number | null; unlock_method: "passkey" | "password" | "passphrase" | null; app_lock: number;
  backup_used_at: number | null; has_pk: number; has_pw: number;
};

/** Every route registered after this needs a valid session. Sessions renew while in use, up to 180 days. */
export const requireUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = readSessionToken(c);
  if (!token || token.length > 100) return c.json({ error: "auth" }, 401);
  const now = Date.now();
  const tokenHash = await sha256Hex(token);
  const db = c.env.DB;
  const s = await db
    .prepare(
      `SELECT s.created_at, s.expires_at, s.last_used_at, s.unlock_hash, s.unlocked_at, s.unlock_method,
         u.id, u.username, u.display_name, u.lang, u.is_owner, u.app_lock, u.backup_used_at, u.pw_hash IS NOT NULL AS has_pw,
         EXISTS (SELECT 1 FROM passkeys p WHERE p.user_id = u.id AND ${PK_COUNTS}) AS has_pk
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ? AND s.created_at > ?`,
    )
    .bind(tokenHash, now, now - MAX_SESSION_MS)
    .first<SessionRow>();
  if (!s) {
    clearSessionCookie(c);
    return c.json({ error: "auth" }, 401);
  }
  const writes: D1PreparedStatement[] = [];
  const renewed = renewedExpiry(s.created_at, s.expires_at, now);
  if (renewed) writes.push(db.prepare("UPDATE sessions SET expires_at = ? WHERE token_hash = ?").bind(renewed, tokenHash));
  // "Last used" for the devices list and "last seen" for the owner: at most one write an hour.
  if (!s.last_used_at || now - s.last_used_at > HOUR) {
    writes.push(db.prepare("UPDATE sessions SET last_used_at = ? WHERE token_hash = ?").bind(now, tokenHash));
    writes.push(db.prepare("UPDATE users SET last_seen_at = ? WHERE id = ?").bind(now, s.id));
  }
  if (writes.length) await db.batch(writes);
  if (renewed) setSessionCookie(c, token, renewed, now);

  // Face ID lock: with the lock on, this request must carry the proof the page got from its last Face ID check
  // (X-FZ-Unlock). Only its hash is stored, on this session, for at most UNLOCK_MS.
  // The same proof, made in the last 5 minutes, is the fresh check the sensitive changes need (requireFresh).
  const proof = c.req.header("x-fz-unlock") ?? "";
  const proven = proof.length > 0 && proof.length <= 100 && !!s.unlock_hash && !!s.unlocked_at && s.unlocked_at > now - UNLOCK_MS
    && sameHex(await sha256Hex(proof), s.unlock_hash);
  const locked = s.app_lock === 1 && !proven;
  const held = proven && s.unlock_method ? { at: s.unlocked_at!, method: s.unlock_method } : null;
  c.set("session", { hash: tokenHash, locked, fresh: !!held && isFresh(held, s, now), proof: held });
  c.set("user", { id: s.id, username: s.username, display_name: s.display_name, lang: s.lang, is_owner: s.is_owner === 1 });
  await next();
};

/**
 * F06, F07: a proof is fresh when it is under 5 minutes old AND made the way this person must check now (freshMethod,
 * same rule): someone with a Face ID that counts must use Face ID; anyone else may use their password or passphrase
 * (or a Face ID added after the backup sign-in). A Face ID proof made before the backup sign-in never counts.
 */
function isFresh(p: { at: number; method: string }, s: { backup_used_at: number | null; has_pk: number }, now: number): boolean {
  if (!(p.at > now - FRESH_MS && p.at <= now)) return false;
  if (p.method === "passkey") return s.backup_used_at == null || p.at > s.backup_used_at;
  return s.has_pk !== 1;
}

// While the lock is on and the page has no fresh proof, only these work: sign out, and the Face ID check itself.
const OPEN_WHEN_LOCKED = new Set(["/api/logout", "/api/logout-all", "/api/unlock/options", "/api/unlock"]);

/** Default deny: every route after this refuses a locked session with 423 {"error":"unlock"}. */
export const requireUnlocked: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.get("session").locked && !(c.req.method === "POST" && OPEN_WHEN_LOCKED.has(c.req.path))) {
    return c.json({ error: "unlock" }, 423);
  }
  await next();
};

/** Routes for a signed-in user about the session itself. */
export const sessionRoutes = new Hono<AppEnv>();

sessionRoutes.post("/logout", async (c) => {
  const token = readSessionToken(c);
  if (token) await c.env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256Hex(token)).run();
  clearSessionCookie(c);
  return c.json({ ok: true });
});

/** Sign out everywhere: ends every session of this user, this one included. */
sessionRoutes.post("/logout-all", async (c) => {
  const r = await c.env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(c.get("user").id).run();
  clearSessionCookie(c);
  return c.json({ ok: true, ended: r.meta.changes ?? 0 });
});

sessionRoutes.put("/me", async (c) => {
  const { lang } = await readBody(c, z.object({ lang: z.enum(["es", "en"]) }));
  await c.env.DB.prepare("UPDATE users SET lang = ? WHERE id = ?").bind(lang, c.get("user").id).run();
  return c.json({ ok: true, lang });
});

// Face ID lock, step 1: a challenge for this user's passkeys, tied to this session.
sessionRoutes.post("/unlock/options", async (c) => {
  const lim = await limitIp(c);
  if (lim) return lim;
  const db = c.env.DB;
  const user = c.get("user");
  const { results } = await db.prepare(`SELECT p.cred_id FROM passkeys p JOIN users u ON u.id = p.user_id WHERE p.user_id = ? AND ${PK_COUNTS}`)
    .bind(user.id).all<{ cred_id: string }>();
  if (!results.length) fail("no_passkey", 409);
  const options = await authenticationOptions(c, results.map((r) => r.cred_id));
  await saveChallenge(db, options.challenge, "unlock", Date.now(), { userId: user.id, sessionHash: c.get("session").hash });
  return c.json({ options });
});

// Face ID lock, step 2: a fresh Face ID check gives the page a new proof (kept in its memory only).
// With {enable: true} it also turns the lock on: the lock is only ever turned on by a working Face ID.
sessionRoutes.post("/unlock", async (c) => {
  const lim = await limitIp(c);
  if (lim) return lim;
  const db = c.env.DB;
  const now = Date.now();
  const user = c.get("user");
  const session = c.get("session");
  const { response, enable } = await readBody(c, z.object({ response: AuthenticationSchema, enable: z.boolean().default(false) }));
  const challenge = challengeOf(response.response.clientDataJSON);
  await takeChallenge(db, challenge, "unlock", now, { userId: user.id, sessionHash: session.hash });
  const pk = await db
    .prepare(`SELECT p.id, p.user_id, p.cred_id, p.public_key, p.counter, p.transports FROM passkeys p JOIN users u ON u.id = p.user_id
      WHERE p.cred_id = ? AND p.user_id = ? AND ${PK_COUNTS}`)
    .bind(response.id, user.id)
    .first<PasskeyRow>();
  if (!pk) fail("bad_passkey");
  const counter = await checkAuthentication(c, response as unknown as AuthenticationResponseJSON, challenge, pk);
  const u = await newUnlock(db, session.hash, now, "passkey");
  await db.batch([
    db.prepare("UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?").bind(counter, now, pk.id),
    u.stmt,
    ...(enable ? [db.prepare("UPDATE users SET app_lock = 1 WHERE id = ?").bind(user.id)] : []),
  ]);
  const lock = await db.prepare("SELECT app_lock FROM users WHERE id = ?").bind(user.id).first<{ app_lock: number }>();
  return c.json({ ok: true, unlock: u.unlock, app_lock: lock?.app_lock === 1 });
});

/** How she proves it is her right now: Face ID when she has one, else her own password, else her passphrase (the
 * backup code). After a sign-in with the backup code, until she adds a Face ID again, her old Face ID does not count
 * (it is the one she lost): the check is then her password, or that code again. */
async function freshMethod(db: D1Database, userId: number): Promise<"passkey" | "password" | "passphrase"> {
  const r = await db
    .prepare(
      `SELECT EXISTS (SELECT 1 FROM passkeys WHERE user_id = ?1) AS pk, pw_hash IS NOT NULL AS pw,
         (backup_used_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM passkeys WHERE user_id = ?1 AND created_at > backup_used_at)) AS after_backup
       FROM users WHERE id = ?1`,
    )
    .bind(userId)
    .first<{ pk: number; pw: number; after_backup: number }>();
  return r?.pk && !r.after_backup ? "passkey" : r?.pw ? "password" : "passphrase";
}

/**
 * Melvin's decision 2 (Nov 25 2026), on the server: a sensitive change needs a proof made in the last 5 minutes
 * (FRESH_MS), even with the lock off. Without one: 403 {"error":"reauth","method"} and the page asks for Face ID
 * (or the password) and sends the request again. Returns the 403, or null to go on.
 */
export async function requireFresh(c: Context<AppEnv>): Promise<Response | null> {
  if (c.get("session").fresh) return null;
  return c.json({ error: "reauth", method: await freshMethod(c.env.DB, c.get("user").id) }, 403);
}

// The fresh check for someone without a Face ID: her own password again (its PBKDF2 result), or, with no password
// either, her passphrase (Melvin today). The same counters as sign-in (per IP, and per name and IP), so this is
// no way around them. Someone with a Face ID uses /unlock instead.
sessionRoutes.post("/reauth", async (c) => {
  const db = c.env.DB;
  const now = Date.now();
  const ipRes = await ipGate(c);
  if (ipRes) return ipRes;
  const user = c.get("user");
  const b = await readBody(c, z.object({ key: z.string().regex(PW_KEY_RE).optional(), passphrase: z.string().min(1).max(200).optional() }));
  const method = await freshMethod(db, user.id);
  if (method === "passkey") fail("use_passkey", 409);
  if ((method === "password") !== !!b.key || !b.key === !b.passphrase) fail("invalid:body");
  const { nKey, state, res } = await nameGate(c, user.username);
  if (res) return res;
  const row = await db.prepare("SELECT pass_salt, pass_hash, pw_salt, pw_hash FROM users WHERE id = ?").bind(user.id)
    .first<{ pass_salt: string; pass_hash: string; pw_salt: string | null; pw_hash: string | null }>();
  const ok = b.key
    ? !!row?.pw_hash && sameHex(await hashPasswordKey(b.key, row.pw_salt ?? NO_SALT), row.pw_hash)
    : !!row && sameHex(await hashPassphrase(b.passphrase!, row.pass_salt), row.pass_hash);
  if (!ok) {
    if (state.last) return tooMany(c, "locked", state.retryAfterS);
    return c.json({ error: "bad_password", tries_left: state.triesLeft }, 403);
  }
  const u = await newUnlock(db, c.get("session").hash, now, b.key ? "password" : "passphrase");
  await db.batch([db.prepare("DELETE FROM login_limits WHERE k = ?").bind(nKey), u.stmt]);
  return c.json({ ok: true, unlock: u.unlock });
});

/** Owner only: the users and how many active sessions each has. */
export const ownerRoutes = new Hono<AppEnv>();

export function ownerOnly(c: Context) {
  if (!c.get("user").is_owner) throw new HTTPException(403, { message: "owner_only" });
}

ownerRoutes.get("/users", async (c) => {
  ownerOnly(c);
  const now = Date.now();
  const { results } = await c.env.DB
    .prepare(
      `SELECT u.id, u.username, u.display_name, u.is_owner,
         (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.expires_at > ? AND s.created_at > ?) AS sessions
       FROM users u ORDER BY u.id`,
    )
    .bind(now, now - MAX_SESSION_MS)
    .all<{ id: number; username: string; display_name: string; is_owner: number; sessions: number }>();
  return c.json({ users: results.map((u) => ({ ...u, is_owner: u.is_owner === 1 })) });
});

/** Owner only: end every session of one user (a lost phone, a shared passphrase). */
ownerRoutes.post("/users/:id/logout-all", async (c) => {
  ownerOnly(c);
  const id = idParam(c);
  const db = c.env.DB;
  const exists = await db.prepare("SELECT 1 FROM users WHERE id = ?").bind(id).first();
  if (!exists) notFound();
  const r = await db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(id).run();
  if (id === c.get("user").id) clearSessionCookie(c);
  return c.json({ ok: true, ended: r.meta.changes ?? 0 });
});
