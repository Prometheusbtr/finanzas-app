// Passkeys (Face ID) with @simplewebauthn/server 14.1.0. Rules from SECURITY.md:
// - rpID and the expected origin come from config (wrangler vars), never from the request.
// - No attestation. Any format other than "none" (or "packed" without a certificate chain) is refused BEFORE
//   verifying, so the library never fetches a revocation list. MetadataService is never used.
// - User verification (Face ID, Touch ID or the device code) is required on every call.
// - Challenges are stored here, used once (deleted on use), and expire after 5 minutes.
import type { Context } from "hono";
import {
  generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type { AuthenticationResponseJSON, RegistrationResponseJSON, WebAuthnCredential } from "@simplewebauthn/server";
import { decodeAttestationObject, isoBase64URL } from "@simplewebauthn/server/helpers";
import { z } from "zod";
import { fail } from "./session.ts";
import type { AppEnv } from "../types.ts";

export const CHALLENGE_MS = 5 * 60 * 1000;
export const RP_NAME = "Finanzas";
export type Purpose = "signup" | "reset" | "register" | "login" | "unlock";

export function rp(c: Context<AppEnv>) {
  return { rpID: c.env.RP_ID as string, origin: c.env.APP_ORIGIN as string };
}

const b64 = z.string().min(1).max(4096).regex(/^[A-Za-z0-9_-]+={0,2}$/);
// What @simplewebauthn/browser sends back. Extra keys are kept for the library to see.
export const RegistrationSchema = z.looseObject({
  id: b64, rawId: b64, type: z.literal("public-key"),
  response: z.looseObject({
    clientDataJSON: b64, attestationObject: b64.max(16384),
    transports: z.array(z.string().max(20)).max(10).optional(),
  }),
  clientExtensionResults: z.looseObject({}).default({}),
  authenticatorAttachment: z.string().max(40).optional(),
});
export const AuthenticationSchema = z.looseObject({
  id: b64, rawId: b64, type: z.literal("public-key"),
  response: z.looseObject({ clientDataJSON: b64, authenticatorData: b64, signature: b64, userHandle: b64.optional() }),
  clientExtensionResults: z.looseObject({}).default({}),
  authenticatorAttachment: z.string().max(40).optional(),
});

/** A random WebAuthn user handle (user.id): 32 random bytes, base64url. */
export function newHandle(): string {
  return isoBase64URL.fromBuffer(crypto.getRandomValues(new Uint8Array(32)));
}

/** The challenge the browser signed, read from clientDataJSON (the library checks it again). */
export function challengeOf(clientDataJSON: string): string {
  try {
    const c = JSON.parse(isoBase64URL.toUTF8String(clientDataJSON)).challenge;
    if (typeof c === "string" && c.length > 0 && c.length <= 200) return c;
  } catch {}
  fail("bad_passkey");
}

/** Store a challenge (5 minutes) and clean old ones in the same step. */
export function saveChallenge(
  db: D1Database, challenge: string, purpose: Purpose, now: number,
  o: { userId?: number | null; inviteId?: number | null; sessionHash?: string | null; data?: unknown } = {},
) {
  return db.batch([
    db.prepare("DELETE FROM webauthn_challenges WHERE expires_at <= ?").bind(now),
    db.prepare(
      `INSERT INTO webauthn_challenges (challenge, purpose, user_id, invite_id, session_hash, data, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(challenge, purpose, o.userId ?? null, o.inviteId ?? null, o.sessionHash ?? null, JSON.stringify(o.data ?? {}), now + CHALLENGE_MS),
  ]);
}

export type ChallengeRow = {
  challenge: string; purpose: Purpose; user_id: number | null; invite_id: number | null; session_hash: string | null; data: string;
};

/**
 * Use a challenge up: deleted in the same statement that reads it, so two requests can never both use it.
 * It must be for this purpose and still fresh; `where` adds the owner checks (user, session, invite).
 */
export async function takeChallenge(
  db: D1Database, challenge: string, purpose: Purpose, now: number,
  where: { userId?: number; sessionHash?: string; inviteId?: number } = {}, code = "bad_passkey",
): Promise<ChallengeRow> {
  const row = await db
    .prepare(
      `DELETE FROM webauthn_challenges WHERE challenge = ? AND purpose = ? AND expires_at > ?
       AND (?4 IS NULL OR user_id = ?4) AND (?5 IS NULL OR session_hash = ?5) AND (?6 IS NULL OR invite_id = ?6)
       RETURNING challenge, purpose, user_id, invite_id, session_hash, data`,
    )
    .bind(challenge, purpose, now, where.userId ?? null, where.sessionHash ?? null, where.inviteId ?? null)
    .first<ChallengeRow>();
  if (!row) fail(code);
  return row;
}

export async function registrationOptions(
  c: Context<AppEnv>,
  user: { username: string; displayName: string; handle: string },
  exclude: string[],
) {
  const { rpID } = rp(c);
  return generateRegistrationOptions({
    rpName: RP_NAME, rpID, userName: user.username, userDisplayName: user.displayName,
    userID: isoBase64URL.toBuffer(user.handle),
    attestationType: "none",
    excludeCredentials: exclude.map((id) => ({ id })),
    // The passkey lives on her own device (Face ID), it is discoverable (sign in without typing a name),
    // and the device must check who is holding it.
    authenticatorSelection: { authenticatorAttachment: "platform", residentKey: "required", userVerification: "required" },
    timeout: 120_000,
  });
}

/** Refuse any attestation that could make the library fetch a revocation list. */
export function assertNoAttestation(attestationObject: string) {
  let fmt: string;
  let x5c: unknown;
  try {
    const att = decodeAttestationObject(isoBase64URL.toBuffer(attestationObject));
    fmt = att.get("fmt");
    x5c = att.get("attStmt")?.get("x5c");
  } catch {
    fail("bad_passkey");
  }
  if (fmt === "none") return;
  if (fmt === "packed" && x5c === undefined) return;
  fail("attestation");
}

/** Check a new passkey. Returns what to store, or throws a 400. */
export async function checkRegistration(c: Context<AppEnv>, response: RegistrationResponseJSON, expectedChallenge: string) {
  assertNoAttestation(response.response.attestationObject);
  const { rpID, origin } = rp(c);
  let r;
  try {
    r = await verifyRegistrationResponse({
      response, expectedChallenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true, requireUserPresence: true,
    });
  } catch {
    fail("bad_passkey");
  }
  if (!r.verified || !r.registrationInfo.userVerified) fail("bad_passkey");
  const cred = r.registrationInfo.credential;
  return {
    credId: cred.id,
    publicKey: isoBase64URL.fromBuffer(cred.publicKey),
    counter: cred.counter,
    transports: JSON.stringify((response.response.transports ?? []).slice(0, 10)),
  };
}

export async function authenticationOptions(c: Context<AppEnv>, allow: string[]) {
  return generateAuthenticationOptions({
    rpID: rp(c).rpID,
    userVerification: "required",
    allowCredentials: allow.map((id) => ({ id })),
    timeout: 120_000,
  });
}

export type PasskeyRow = { id: number; user_id: number; cred_id: string; public_key: string; counter: number; transports: string };

/** Check a sign-in with a stored passkey. Returns the new counter, or throws a 400. */
export async function checkAuthentication(
  c: Context<AppEnv>, response: AuthenticationResponseJSON, expectedChallenge: string, pk: PasskeyRow,
): Promise<number> {
  const { rpID, origin } = rp(c);
  let transports: string[] = [];
  try {
    transports = JSON.parse(pk.transports);
  } catch {}
  const credential: WebAuthnCredential = {
    id: pk.cred_id, publicKey: isoBase64URL.toBuffer(pk.public_key), counter: pk.counter, transports: transports as WebAuthnCredential["transports"],
  };
  let r;
  try {
    r = await verifyAuthenticationResponse({
      response, expectedChallenge, expectedOrigin: origin, expectedRPID: rpID, credential, requireUserVerification: true,
    });
  } catch {
    fail("bad_passkey");
  }
  if (!r.verified || !r.authenticationInfo.userVerified) fail("bad_passkey");
  return r.authenticationInfo.newCounter;
}
