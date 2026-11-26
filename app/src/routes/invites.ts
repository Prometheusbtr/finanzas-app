// Invites and sign-up, Face ID reset links, and the owner's "Personas en la app".
// - An invite is 32 random bytes; only its SHA-256 is stored. It lasts 7 days, is used once, at most 2 are open.
// - The link's origin is APP_ORIGIN (config), never the Host header. The token rides after "#", so it never
//   reaches a server log; the page reads it and removes it from the address bar.
// - A wrong, used, cancelled or expired invite always gets the same answer: 404 {"error":"invite_invalid"}.
// - Sign-up uses the invite up and makes the user, her passkey (or password) and her session in ONE batch,
//   so two sign-ups with one invite cannot both work (the invites_once trigger rolls the second one back).
// - No owner route here returns an amount or a movement.
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { RegistrationResponseJSON } from "@simplewebauthn/server";
import {
  generatePassphrase, hashPassphrase, hashPasswordKey, MAX_SESSION_MS, newSalt, newSessionToken, normalizeUsername, PW_ITER, PW_KEY_RE,
  sha256Hex,
} from "../lib/auth.ts";
import { idParam, notFound, readBody } from "../lib/http.ts";
import {
  challengeOf, checkRegistration, newHandle, RegistrationSchema, registrationOptions, saveChallenge, takeChallenge,
} from "../lib/passkeys.ts";
import { clearSessionCookie, deviceLabel, fail, limitIp, newSession } from "../lib/session.ts";
import { newUserStatements, toD1, USERNAME_RE } from "../lib/users.ts";
import { fakeSaltFor, ownerOnly, requireFresh } from "./auth.ts";
import type { AppEnv } from "../types.ts";

const DAY = 24 * 60 * 60 * 1000;
export const INVITE_MS = 7 * DAY;
export const RESET_MS = 3 * DAY;
/** Melvin's decision 1 (Nov 25 2026): a reset link works only from 24 h after it is made (until RESET_MS), so she
 * sees it in the app first (Home, Mi cuenta) and can cancel it. The invites_reset_wait trigger (0005) holds the
 * same rule in the database. */
export const RESET_WAIT_MS = DAY;
export const MAX_OPEN_INVITES = 2;

const Token = z.string().min(1).max(100);
const displayName = z.string().trim().min(1).max(60);

type InviteRow = {
  id: number; created_at: number; expires_at: number; inviter: string;
  target_id: number | null; target_name: string | null; target_username: string | null; target_handle: string | null;
};

/** An open invite (or reset link) for this token, or null. */
async function openInvite(db: D1Database, token: string, kind: "signup" | "reset", now: number): Promise<InviteRow | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  return db
    .prepare(
      `SELECT i.id, i.created_at, i.expires_at, o.display_name AS inviter,
         i.target_id, t.display_name AS target_name, t.username AS target_username, t.passkey_handle AS target_handle
       FROM invites i JOIN users o ON o.id = i.owner_id LEFT JOIN users t ON t.id = i.target_id
       WHERE i.token_hash = ? AND i.kind = ? AND i.used_at IS NULL AND i.cancelled_at IS NULL AND i.expires_at > ?`,
    )
    .bind(await sha256Hex(token), kind, now)
    .first<InviteRow>();
}

function invalid(): never {
  fail("invite_invalid", 404);
}

function link(c: Context<AppEnv>, path: "unirse" | "restablecer", token: string) {
  return `${c.env.APP_ORIGIN}/#/${path}?c=${token}`;
}

/** Turn a failed sign-up or reset batch into its one public answer. */
function batchError(e: unknown): never {
  const m = e instanceof Error ? e.message : "";
  if (m.includes("invite_closed")) invalid();
  if (m.includes("users.username")) fail("name_taken", 409);
  if (m.includes("passkeys.cred_id")) fail("bad_passkey");
  throw e;
}

/** Without a session: open an invite, sign up, use a Face ID reset link. */
export const invitePublicRoutes = new Hono<AppEnv>();

// Who invited her (shown on the welcome screen). Nothing is used up.
invitePublicRoutes.post("/invite", async (c) => {
  const lim = await limitIp(c);
  if (lim) return lim;
  const { token } = await readBody(c, z.object({ token: Token }));
  const inv = await openInvite(c.env.DB, token, "signup", Date.now());
  if (!inv) invalid();
  return c.json({ inviter: inv.inviter, expires_at: inv.expires_at });
});

// Sign-up, step 1: her name and username. Returns the Face ID options, and the salt for the password fallback.
// The chosen name waits with the challenge (5 minutes); nothing is made yet.
invitePublicRoutes.post("/signup/options", async (c) => {
  const lim = await limitIp(c);
  if (lim) return lim;
  const db = c.env.DB;
  const now = Date.now();
  const b = await readBody(c, z.object({ token: Token, username: z.string().min(1).max(64), display_name: displayName, lang: z.enum(["es", "en"]) }));
  const inv = await openInvite(db, b.token, "signup", now);
  if (!inv) invalid();
  const username = normalizeUsername(b.username);
  if (!USERNAME_RE.test(username)) fail("invalid:username");
  if (await db.prepare("SELECT 1 FROM users WHERE username = ?").bind(username).first()) fail("name_taken", 409);
  const handle = newHandle();
  const pwSalt = await fakeSaltFor(db, username); // the same salt /login/salt gives for this name, before and after
  const options = await registrationOptions(c, { username, displayName: b.display_name, handle }, []);
  await saveChallenge(db, options.challenge, "signup", now, {
    inviteId: inv.id, data: { username, display_name: b.display_name, lang: b.lang, handle, pw_salt: pwSalt },
  });
  return c.json({ options, ticket: options.challenge, pw_salt: pwSalt, iter: PW_ITER });
});

// Sign-up, step 2: Face ID's answer (or, when Face ID did not work, her password's PBKDF2 result).
// One batch: use the invite up, make the user with the starter groups, store the passkey, start the session.
// The backup code is made here and shown once; only its salted hash is stored.
invitePublicRoutes.post("/signup", async (c) => {
  const lim = await limitIp(c);
  if (lim) return lim;
  const db = c.env.DB;
  const now = Date.now();
  const b = await readBody(c, z.object({
    token: Token,
    response: RegistrationSchema.optional(),
    ticket: z.string().min(1).max(200).optional(),
    password_key: z.string().regex(PW_KEY_RE).optional(),
  }));
  if (!b.response === !b.password_key) fail("invalid:body");
  const inv = await openInvite(db, b.token, "signup", now);
  if (!inv) invalid();
  const challenge = b.response ? challengeOf(b.response.response.clientDataJSON) : b.ticket;
  if (!challenge) fail("invalid:ticket");
  const row = await takeChallenge(db, challenge, "signup", now, { inviteId: inv.id }, b.response ? "bad_passkey" : "expired");
  const data = JSON.parse(row.data) as { username: string; display_name: string; lang: "es" | "en"; handle: string; pw_salt: string };

  const cred = b.response ? await checkRegistration(c, b.response as unknown as RegistrationResponseJSON, challenge) : null;
  const pwHash = b.password_key ? await hashPasswordKey(b.password_key, data.pw_salt) : null;
  const backup = generatePassphrase();
  const passSalt = newSalt();
  const s = await newSession(c, db, { username: data.username }, now);
  const stmts: D1PreparedStatement[] = [
    db.prepare("UPDATE invites SET used_at = ? WHERE id = ?").bind(now, inv.id),
    ...toD1(db, newUserStatements({
      username: data.username, displayName: data.display_name, lang: data.lang,
      passSalt, passHash: await hashPassphrase(backup, passSalt), owner: "never", defaults: true, setupCard: "open",
      passkeyHandle: data.handle, pwSalt: pwHash ? data.pw_salt : null, pwHash, now,
    })),
  ];
  if (cred) {
    stmts.push(db.prepare(
      `INSERT INTO passkeys (user_id, cred_id, public_key, counter, transports, label, created_at)
       VALUES ((SELECT id FROM users WHERE username = ?), ?, ?, ?, ?, ?, ?)`,
    ).bind(data.username, cred.credId, cred.publicKey, cred.counter, cred.transports, deviceLabel(c.req.header("user-agent")), now));
  }
  stmts.push(s.cleanup, s.stmt);
  try {
    await db.batch(stmts);
  } catch (e) {
    batchError(e);
  }
  s.setCookie();
  return c.json({ ok: true, backup_code: backup });
});

/** A reset link in its first 24 hours: nothing happens yet, the page says from when it works. */
function notYet(c: Context<AppEnv>, inv: InviteRow, now: number) {
  const usable = inv.created_at + RESET_WAIT_MS;
  return now < usable ? c.json({ error: "reset_not_yet", usable_at: usable }, 409) : null;
}

// Face ID reset link (made by the owner): who it is for, or, in its first 24 hours, only from when it works.
invitePublicRoutes.post("/reset", async (c) => {
  const lim = await limitIp(c);
  if (lim) return lim;
  const now = Date.now();
  const { token } = await readBody(c, z.object({ token: Token }));
  const inv = await openInvite(c.env.DB, token, "reset", now);
  if (!inv) invalid();
  if (now < inv.created_at + RESET_WAIT_MS) return c.json({ pending: true, usable_at: inv.created_at + RESET_WAIT_MS });
  return c.json({ display_name: inv.target_name, username: inv.target_username });
});

invitePublicRoutes.post("/reset/options", async (c) => {
  const lim = await limitIp(c);
  if (lim) return lim;
  const db = c.env.DB;
  const now = Date.now();
  const { token } = await readBody(c, z.object({ token: Token }));
  const inv = await openInvite(db, token, "reset", now);
  if (!inv) invalid();
  const wait = notYet(c, inv, now);
  if (wait) return wait;
  const handle = inv.target_handle ?? newHandle();
  const options = await registrationOptions(c, { username: inv.target_username!, displayName: inv.target_name!, handle }, []);
  await saveChallenge(db, options.challenge, "reset", now, { inviteId: inv.id, userId: inv.target_id, data: { handle } });
  return c.json({ options });
});

// Using the reset link: in one batch, use it up, remove her old passkeys, end all her sessions (only now: making
// the link no longer does), store the new passkey, start a session.
invitePublicRoutes.post("/reset/finish", async (c) => {
  const lim = await limitIp(c);
  if (lim) return lim;
  const db = c.env.DB;
  const now = Date.now();
  const b = await readBody(c, z.object({ token: Token, response: RegistrationSchema }));
  const inv = await openInvite(db, b.token, "reset", now);
  if (!inv) invalid();
  const wait = notYet(c, inv, now);
  if (wait) return wait;
  const challenge = challengeOf(b.response.response.clientDataJSON);
  const row = await takeChallenge(db, challenge, "reset", now, { inviteId: inv.id, userId: inv.target_id! });
  const { handle } = JSON.parse(row.data) as { handle: string };
  const cred = await checkRegistration(c, b.response as unknown as RegistrationResponseJSON, challenge);
  const uid = inv.target_id!;
  const s = await newSession(c, db, uid, now);
  try {
    await db.batch([
      db.prepare("UPDATE invites SET used_at = ? WHERE id = ?").bind(now, inv.id),
      db.prepare("UPDATE users SET passkey_handle = COALESCE(passkey_handle, ?) WHERE id = ?").bind(handle, uid),
      db.prepare("DELETE FROM passkeys WHERE user_id = ?").bind(uid),
      db.prepare(
        `INSERT INTO passkeys (user_id, cred_id, public_key, counter, transports, label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(uid, cred.credId, cred.publicKey, cred.counter, cred.transports, deviceLabel(c.req.header("user-agent")), now),
      db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(uid),
      s.cleanup,
      s.stmt,
    ]);
  } catch (e) {
    batchError(e);
  }
  s.setCookie();
  return c.json({ ok: true });
});

/** Owner only: "Personas en la app". Names and dates only, never money. */
export const memberRoutes = new Hono<AppEnv>();

memberRoutes.get("/members", async (c) => {
  ownerOnly(c);
  const db = c.env.DB;
  const now = Date.now();
  const [people, invites] = await db.batch([
    db.prepare(
      `SELECT u.id, u.username, u.display_name, u.is_owner, u.created_at AS joined,
         MAX(COALESCE(u.last_seen_at, 0), COALESCE((SELECT MAX(s.last_used_at) FROM sessions s WHERE s.user_id = u.id), 0)) AS last_seen,
         (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.expires_at > ?1 AND s.created_at > ?2) AS sessions,
         (SELECT COUNT(*) FROM passkeys p WHERE p.user_id = u.id) AS passkeys
       FROM users u ORDER BY u.id`,
    ).bind(now, now - MAX_SESSION_MS),
    db.prepare(
      `SELECT i.id, i.kind, i.target_id, i.created_at, i.expires_at FROM invites i
       WHERE i.owner_id = ? AND i.used_at IS NULL AND i.cancelled_at IS NULL AND i.expires_at > ? ORDER BY i.id`,
    ).bind(c.get("user").id, now),
  ]);
  type Inv = { id: number; kind: string; target_id: number | null; created_at: number; expires_at: number };
  // a reset link shows from when it works ("pendiente, funciona desde ...")
  const open = (invites.results as Inv[]).map((i) => (i.kind === "reset" ? { ...i, usable_at: i.created_at + RESET_WAIT_MS } : i));
  type P = { id: number; username: string; display_name: string; is_owner: number; joined: number; last_seen: number; sessions: number; passkeys: number };
  return c.json({
    people: (people.results as P[]).map((p) => ({ ...p, is_owner: p.is_owner === 1, last_seen: p.last_seen || null })),
    invites: open,
    max_invites: MAX_OPEN_INVITES,
  });
});

// A new sign-up invite. "At most 2 open" is checked inside the same INSERT, so two clicks at once cannot make 3.
memberRoutes.post("/invites", async (c) => {
  ownerOnly(c);
  const db = c.env.DB;
  const now = Date.now();
  const token = newSessionToken();
  const row = await db
    .prepare(
      `INSERT INTO invites (owner_id, kind, token_hash, created_at, expires_at)
       SELECT ?1, 'signup', ?2, ?3, ?4
       WHERE (SELECT COUNT(*) FROM invites WHERE owner_id = ?1 AND kind = 'signup' AND used_at IS NULL AND cancelled_at IS NULL AND expires_at > ?3) < ?5
       RETURNING id, expires_at`,
    )
    .bind(c.get("user").id, await sha256Hex(token), now, now + INVITE_MS, MAX_OPEN_INVITES)
    .first<{ id: number; expires_at: number }>();
  if (!row) fail("too_many_invites", 409);
  return c.json({ id: row.id, url: link(c, "unirse", token), expires_at: row.expires_at });
});

memberRoutes.delete("/invites/:id", async (c) => {
  ownerOnly(c);
  const id = idParam(c);
  const r = await c.env.DB
    .prepare("UPDATE invites SET cancelled_at = ?, cancelled_by = 'owner' WHERE id = ? AND owner_id = ? AND used_at IS NULL AND cancelled_at IS NULL")
    .bind(Date.now(), id, c.get("user").id)
    .run();
  if (!r.meta.changes) notFound();
  return c.json({ ok: true });
});

/** A person who is not the owner, or 404. */
async function member(c: Context<AppEnv>, id: number) {
  const m = await c.env.DB.prepare("SELECT id, username, is_owner FROM users WHERE id = ?").bind(id)
    .first<{ id: number; username: string; is_owner: number }>();
  if (!m) notFound();
  if (m.is_owner === 1) fail("owner_self", 403);
  return m;
}

// Reset her Face ID: a one-use link that works from 24 h after it is made until 3 days (Melvin's decision, Nov 25
// 2026). One open link per person: a new one replaces the older. Making it changes nothing else: she sees it on
// Home and in Mi cuenta and can cancel it; using it removes her old passkeys, registers a new one and ends her
// sessions. Making one needs the owner's fresh check (Melvin, Nov 25 2026), so his unlocked phone alone can't.
memberRoutes.post("/members/:id/reset", async (c) => {
  ownerOnly(c);
  const db = c.env.DB;
  const m = await member(c, idParam(c));
  const fresh = await requireFresh(c);
  if (fresh) return fresh;
  const now = Date.now();
  const token = newSessionToken();
  const [, ins] = await db.batch<{ id: number; expires_at: number }>([
    db.prepare("UPDATE invites SET cancelled_at = ?, cancelled_by = 'replaced' WHERE kind = 'reset' AND target_id = ? AND used_at IS NULL AND cancelled_at IS NULL").bind(now, m.id),
    db.prepare(
      "INSERT INTO invites (owner_id, kind, target_id, token_hash, created_at, expires_at) VALUES (?, 'reset', ?, ?, ?, ?) RETURNING id, expires_at",
    ).bind(c.get("user").id, m.id, await sha256Hex(token), now, now + RESET_MS),
  ]);
  const r = ins.results[0]!;
  return c.json({ id: r.id, url: link(c, "restablecer", token), usable_at: now + RESET_WAIT_MS, expires_at: r.expires_at });
});

// Remove a person and everything that is hers (every table's rows go with the user: ON DELETE CASCADE).
// Needs the owner's fresh check (Melvin, Nov 25 2026), after the typed name so a typo asks for nothing.
memberRoutes.delete("/members/:id", async (c) => {
  ownerOnly(c);
  const m = await member(c, idParam(c));
  const { confirm } = await readBody(c, z.object({ confirm: z.string().max(64) }));
  if (normalizeUsername(confirm) !== m.username) fail("confirm");
  const fresh = await requireFresh(c);
  if (fresh) return fresh;
  await c.env.DB.prepare("DELETE FROM users WHERE id = ? AND is_owner = 0").bind(m.id).run();
  return c.json({ ok: true });
});

/** Signed in: delete my own account and all my data. The owner cannot (he owns the server and everyone's access). */
export async function deleteSelf(c: Context<AppEnv>) {
  const user = c.get("user");
  if (user.is_owner) fail("owner_cannot_delete", 403);
  const { confirm } = await readBody(c, z.object({ confirm: z.string().max(64) }));
  if (normalizeUsername(confirm) !== user.username) fail("confirm");
  await c.env.DB.prepare("DELETE FROM users WHERE id = ? AND is_owner = 0").bind(user.id).run();
  clearSessionCookie(c);
  return c.json({ ok: true });
}
