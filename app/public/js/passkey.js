// Face ID (passkeys) and the own-password fallback, in the browser.
// The WebAuthn calls come from @simplewebauthn/browser 14.0.0, vendored in /vendor (never from a CDN). It is
// loaded only when a Face ID prompt is about to open, so the app shell (sw.js) starts offline without it.
// The password never leaves the phone: PBKDF2-SHA256 runs here with the server's salt, and only the
// 32-byte result goes to the server (which stores a salted hash of it).
import { api } from "./api.js";

export const PW_MIN = 12;
const VENDOR = "/vendor/simplewebauthn-browser-14.0.0/esm/index.js";
const lib = () => import(VENDOR);

/** The same test as the library's browserSupportsWebAuthn(). */
export const canPasskey = () => typeof window.PublicKeyCredential === "function";

/** Make a new passkey from the server's options (Face ID prompt). Throws when she cancels or it fails. */
export const createPasskey = async (optionsJSON) => (await lib()).startRegistration({ optionsJSON });
/** Use a passkey for the server's options (Face ID prompt). */
export const usePasskey = async (optionsJSON) => (await lib()).startAuthentication({ optionsJSON });

/** PBKDF2-SHA256(password, salt, iter) as 64 hex characters. */
export async function passwordKey(password, salt, iter) {
  const enc = new TextEncoder();
  const base = await crypto.subtle.importKey("raw", enc.encode(password.normalize("NFC")), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: enc.encode(salt), iterations: iter }, base, 256);
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The backup code is the app-made passphrase (25 letters and numbers once dashes and spaces go). */
export const looksLikeBackupCode = (s) => /^[abcdefghjkmnpqrstuvwxyz23456789]{25}$/.test(String(s).toLowerCase().replace(/[\s-]/g, ""));

/** Add a Face ID device for the signed-in user. Returns the new lock proof. */
export async function addPasskey() {
  const { options } = await api("/passkeys/options", { method: "POST" });
  const response = await createPasskey(options);
  const r = await api("/passkeys", { method: "POST", body: { response } });
  return r.unlock;
}

/** A Face ID check for this session (the lock). enable: also turn the lock on. */
export async function unlockWithPasskey(enable = false) {
  const { options } = await api("/unlock/options", { method: "POST" });
  const response = await usePasskey(options);
  return api("/unlock", { method: "POST", body: { response, enable } });
}

/** A short reason for a failed Face ID prompt or check, as an i18n key. */
export function passkeyError(e) {
  const n = e && e.name;
  if (n === "NotAllowedError" || n === "AbortError") return "fidCancelled";
  if (n === "InvalidStateError") return "fidExists";
  if (e && e.code === "offline") return "offline";
  return "fidFailed";
}
