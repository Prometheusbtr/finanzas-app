// Sessions, the session cookie and the per-IP try counters, shared by every way of signing in
// (passphrase or backup code, own password, passkey, sign-up, Face ID reset).
import type { Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import {
  IP_TRIES, IP_WINDOW_MS, ipKey, isLocalDev, LOCK_MS, MAX_SESSION_MS, newSessionToken, SESSION_MS, sessionCookieName, sha256Hex,
  windowState,
} from "./auth.ts";

function cookieOptions(c: Context, maxAgeS: number) {
  return {
    path: "/",
    httpOnly: true,
    secure: !isLocalDev(c.req.url),
    sameSite: "Strict" as const,
    maxAge: Math.max(0, Math.floor(maxAgeS)),
  };
}

export function setSessionCookie(c: Context, token: string, expiresAt: number, now: number) {
  setCookie(c, sessionCookieName(c.req.url), token, cookieOptions(c, (expiresAt - now) / 1000));
}

export function clearSessionCookie(c: Context) {
  setCookie(c, sessionCookieName(c.req.url), "", cookieOptions(c, 0));
}

export function readSessionToken(c: Context): string | undefined {
  return getCookie(c, sessionCookieName(c.req.url));
}

/** Cloudflare puts the visitor's address in this header and overwrites any value the visitor sends. */
export function clientIp(c: Context): string | undefined {
  return c.req.header("cf-connecting-ip");
}

/** "iPhone · Safari": a plain device label for the sessions list. Only these fixed words, never the raw header. */
export function deviceLabel(ua: string | undefined): string {
  const s = ua ?? "";
  const device = /iPhone/.test(s) ? "iPhone" : /iPad/.test(s) ? "iPad" : /Android/.test(s) ? "Android"
    : /Macintosh|Mac OS X/.test(s) ? "Mac" : /Windows/.test(s) ? "Windows" : /CrOS/.test(s) ? "ChromeOS" : /Linux/.test(s) ? "Linux" : "";
  const browser = /Edg\//.test(s) ? "Edge" : /Firefox\/|FxiOS/.test(s) ? "Firefox" : /Chrome\/|CriOS/.test(s) ? "Chrome"
    : /Safari\//.test(s) ? "Safari" : "";
  return [device, browser].filter(Boolean).join(" · ");
}

/** How long a Face ID lock proof can last at most. The page itself drops it sooner (reload, 5 minutes hidden). */
export const UNLOCK_MS = 12 * 60 * 60 * 1000;
/** Melvin's decision (Nov 25 2026): the changes that could lock her out or hide a takeover (a new backup code, a
 * password, adding or removing a Face ID, deleting the account, cancelling a reset link) need a proof from a check
 * made in the last 5 minutes, even with the lock off. */
export const FRESH_MS = 5 * 60 * 1000;

/** How a lock proof was made: a Face ID, her own password, or the passphrase / backup code. */
export type UnlockMethod = "passkey" | "password" | "passphrase";

/**
 * A new session for a user: the statement that stores it (put it LAST in a batch, after any login-method change,
 * whose trigger ends the older sessions) and the cookie to set once the batch has run.
 * userId: a number, or a username when the user is made in the same batch.
 * unlock: this sign-in was itself a check of who she is (the method says which), so the session starts with a lock
 * proof; `unlock` is the proof for the page to keep in memory (only its hash is stored).
 * unlockedAt: F47, a session that replaces one after a sensitive change keeps the time of the real check, so one
 * check never covers a chain of changes past its 5 minutes.
 */
export async function newSession(
  c: Context, db: D1Database, userId: number | { username: string }, now: number,
  opts: { unlock?: UnlockMethod | null; unlockedAt?: number | null } = {},
) {
  const token = newSessionToken();
  const expiresAt = now + SESSION_MS;
  const label = deviceLabel(c.req.header("user-agent"));
  const hash = await sha256Hex(token);
  const unlock = opts.unlock ? newSessionToken() : null;
  const unlockHash = unlock ? await sha256Hex(unlock) : null;
  const who = typeof userId === "number" ? "?" : "(SELECT id FROM users WHERE username = ?)";
  const stmt = db
    .prepare(
      `INSERT INTO sessions (token_hash, user_id, created_at, expires_at, label, last_used_at, unlock_hash, unlocked_at, unlock_method)
       VALUES (?, ${who}, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(hash, typeof userId === "number" ? userId : userId.username, now, expiresAt, label, now, unlockHash,
      unlock ? Math.min(opts.unlockedAt ?? now, now) : null, unlock ? opts.unlock! : null);
  return {
    stmt,
    hash,
    unlock,
    /** Old expired rows go in the same batch. */
    cleanup: db.prepare("DELETE FROM sessions WHERE expires_at <= ? OR created_at <= ?").bind(now, now - MAX_SESSION_MS),
    setCookie: () => setSessionCookie(c, token, expiresAt, now),
  };
}

/** A fresh lock proof for an existing session, made by `method`: the statement to store its hash, and the proof. */
export async function newUnlock(db: D1Database, sessionHash: string, now: number, method: UnlockMethod) {
  const unlock = newSessionToken();
  return {
    unlock,
    stmt: db.prepare("UPDATE sessions SET unlock_hash = ?, unlocked_at = ?, unlock_method = ? WHERE token_hash = ?")
      .bind(await sha256Hex(unlock), now, method, sessionHash),
  };
}

/** Add one try to a counter and return the count, in one statement (no gap between read and write). */
export function countTry(db: D1Database, key: string, now: number, windowMs: number) {
  return db
    .prepare(
      `INSERT INTO login_limits (k, tries, window_start) VALUES (?1, 1, ?2)
       ON CONFLICT (k) DO UPDATE SET
         tries = CASE WHEN window_start <= ?2 - ?3 THEN 1 ELSE tries + 1 END,
         window_start = CASE WHEN window_start <= ?2 - ?3 THEN ?2 ELSE window_start END
       RETURNING tries, window_start`,
    )
    .bind(key, now, windowMs);
}

export type Counter = { tries: number; window_start: number };

export function tooMany(c: Context, error: "locked" | "slow_down", retryAfterS: number) {
  c.header("Retry-After", String(retryAfterS));
  return c.json({ error, retry_after_s: retryAfterS }, 429);
}

/**
 * M1, step 1, for every way in: the passphrase or backup code, her own password and its salt, Face ID sign-in,
 * the Face ID lock, adding a passkey, invites, sign-up and reset links. They all count on the SAME per-IP
 * counter as login (10 requests a minute), so mixing routes gives no extra tries. Every request counts, even
 * a broken one, before anything is read. Old counter rows are cleaned in the same step.
 * (Seguridad, Nov 25 2026: these routes had their own counter of 20 a minute, on top of login's 10.)
 */
export async function limitIp(c: Context): Promise<Response | null> {
  const db = c.env.DB as D1Database;
  const now = Date.now();
  const [, r] = await db.batch<Counter>([
    db.prepare("DELETE FROM login_limits WHERE window_start <= ?").bind(now - LOCK_MS),
    countTry(db, await ipKey(clientIp(c)), now, IP_WINDOW_MS),
  ]);
  const st = windowState(r.results[0].tries, r.results[0].window_start, now, IP_TRIES, IP_WINDOW_MS);
  return st.allowed ? null : tooMany(c, "slow_down", st.retryAfterS);
}

/** A 400 with one fixed error code (the error handler adds nothing else). */
export function fail(code: string, status: 400 | 403 | 404 | 409 = 400): never {
  throw new HTTPException(status, { message: code });
}
