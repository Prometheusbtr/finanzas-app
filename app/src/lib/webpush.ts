// Web Push with WebCrypto only (no package): the message is encrypted for the phone (RFC 8291, aes128gcm) and the
// request is signed with the app's VAPID key (RFC 8292, an ES256 JWT). The push service sees neither the text nor
// who the person is; it only forwards the encrypted bytes to the phone.

const enc = new TextEncoder();

export function b64u(bytes: Uint8Array | ArrayBuffer): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function unb64u(text: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error("bad_base64url");
  const s = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** The push services the app sends to: Apple (iPhone), Google, Mozilla and Microsoft. https on port 443 only, so a
 * subscription can never make the server call an address of someone's choosing. */
const PUSH_HOSTS: RegExp[] = [
  /^([a-z0-9-]+\.)+push\.apple\.com$/,
  /^fcm\.googleapis\.com$/,
  /^([a-z0-9-]+\.)+push\.services\.mozilla\.com$/,
  /^([a-z0-9-]+\.)+notify\.windows\.com$/,
];

export function isAllowedEndpoint(endpoint: string): boolean {
  if (typeof endpoint !== "string" || endpoint.length > 1024) return false;
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.username || u.password || (u.port && u.port !== "443")) return false;
  if (!endpoint.startsWith(`https://${u.hostname}/`)) return false; // no odd spellings the URL parser rewrites
  return PUSH_HOSTS.some((re) => re.test(u.hostname));
}

/** A browser's subscription keys: p256dh is a P-256 public key (65 bytes, uncompressed), auth 16 random bytes. */
export function validKeys(p256dh: string, auth: string): boolean {
  try {
    const k = unb64u(p256dh);
    return k.length === 65 && k[0] === 4 && unb64u(auth).length === 16;
  } catch {
    return false;
  }
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number) {
  const key = await crypto.subtle.importKey("raw", new Uint8Array(ikm), "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(salt), info: new Uint8Array(info) }, key, bytes * 8));
}

/** JWK for a P-256 private key from its 32-byte d and its 65-byte public key. */
function privateJwk(d: Uint8Array, pub: Uint8Array): JsonWebKey {
  return { kty: "EC", crv: "P-256", d: b64u(d), x: b64u(pub.slice(1, 33)), y: b64u(pub.slice(33, 65)), ext: false };
}

export type EncryptOptions = {
  /** Only for the RFC 8291 test vector: a fixed sender key pair and salt instead of fresh random ones. */
  fixed?: { asPrivate: Uint8Array; asPublic: Uint8Array; salt: Uint8Array<ArrayBuffer> };
};

/** RFC 8291: encrypt one push message for one subscription, as a single aes128gcm record (rs 4096). */
export async function encryptPush(plaintext: Uint8Array, p256dh: string, auth: string, opts: EncryptOptions = {}): Promise<Uint8Array<ArrayBuffer>> {
  const uaPublic = unb64u(p256dh);
  const authSecret = unb64u(auth);
  if (plaintext.length > 3000) throw new Error("too_long");
  let asPrivate: CryptoKey;
  let asPublic: Uint8Array<ArrayBuffer>;
  if (opts.fixed) {
    asPrivate = await crypto.subtle.importKey("jwk", privateJwk(opts.fixed.asPrivate, opts.fixed.asPublic), { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
    asPublic = new Uint8Array(opts.fixed.asPublic);
  } else {
    const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
    asPrivate = pair.privateKey;
    asPublic = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  }
  const salt: Uint8Array<ArrayBuffer> = opts.fixed?.salt ?? crypto.getRandomValues(new Uint8Array(new ArrayBuffer(16)));
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  // (workerd reads `public`; its type file spells it `$public`)
  const ecdhAlg = { name: "ECDH", public: uaKey } as unknown as SubtleCryptoDeriveKeyAlgorithm;
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits(ecdhAlg, asPrivate, 256));
  const ikm = await hkdf(authSecret, ecdh, concat(enc.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", new Uint8Array(cek), "AES-GCM", false, ["encrypt"]);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: new Uint8Array(nonce) }, key, concat(plaintext, new Uint8Array([2]))));
  const header = new Uint8Array(21);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  return concat(header, asPublic, cipher);
}

export type VapidKeys = { publicKey: string; privateKey: string };

/** RFC 8292: the signed claim for one push service. `sub` is the app's own https address, never an email. */
export async function vapidAuthorization(endpoint: string, keys: VapidKeys, subject: string, nowMs: number): Promise<string> {
  const pub = unb64u(keys.publicKey);
  const key = await crypto.subtle.importKey("jwk", privateJwk(unb64u(keys.privateKey), pub), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const head = b64u(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64u(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(nowMs / 1000) + 12 * 3600, sub: subject })));
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(`${head}.${claims}`));
  return `vapid t=${head}.${claims}.${b64u(sig)}, k=${keys.publicKey}`;
}

export type PushTarget = { endpoint: string; p256dh: string; auth: string };
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;
export type VapidSigner = (endpoint: string) => Promise<string>;

/** One signed claim per push service for a whole run (the claim names only the service's origin), so the evening job
 * signs at most 4 times however many phones it reaches: CPU stays inside the free plan's 10 ms. */
export function vapidSigner(keys: VapidKeys, subject: string, nowMs: number): VapidSigner {
  const byOrigin = new Map<string, Promise<string>>();
  return (endpoint) => {
    const aud = new URL(endpoint).origin;
    let p = byOrigin.get(aud);
    if (!p) {
      p = vapidAuthorization(endpoint, keys, subject, nowMs);
      byOrigin.set(aud, p);
    }
    return p;
  };
}

/** Send one encrypted message. Returns the push service's status (201 is delivered to the service; 404 and 410 mean
 * the subscription is gone). Never follows a redirect, and never sends to a host outside the list above. */
export async function sendPush(target: PushTarget, payload: object, keys: VapidKeys, subject: string, fetchFn: FetchLike, nowMs: number, ttlS = 4 * 3600, sign?: VapidSigner): Promise<number> {
  if (!isAllowedEndpoint(target.endpoint)) return 0;
  const body = await encryptPush(enc.encode(JSON.stringify(payload)), target.p256dh, target.auth);
  const res = await fetchFn(target.endpoint, {
    method: "POST",
    redirect: "manual",
    headers: {
      Authorization: await (sign ? sign(target.endpoint) : vapidAuthorization(target.endpoint, keys, subject, nowMs)),
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: String(ttlS),
      Urgency: "normal",
    },
    body,
  });
  return res.status;
}
