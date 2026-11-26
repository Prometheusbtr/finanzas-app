// A software passkey for tests (ES256), built the way a phone's authenticator answers WebAuthn.
// Everything is made with WebCrypto and the library's own CBOR helper, so the server checks it for real.
import { isoBase64URL, isoCBOR } from "@simplewebauthn/server/helpers";

const enc = new TextEncoder();
const b64 = (b: Uint8Array) => isoBase64URL.fromBuffer(b as Uint8Array<ArrayBuffer>);

function concat(...parts: (Uint8Array | number[])[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) {
    out.set(p, i);
    i += p.length;
  }
  return out;
}

async function sha256(b: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", b as Uint8Array<ArrayBuffer>));
}

/** WebCrypto gives r||s; WebAuthn wants an ASN.1 DER signature. */
function der(raw: Uint8Array): Uint8Array {
  const int = (b: Uint8Array) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    let v: Uint8Array = b.slice(i);
    if (v[0] & 0x80) v = concat([0], v);
    return concat([0x02, v.length], v);
  };
  const r = int(raw.slice(0, 32));
  const s = int(raw.slice(32));
  return concat([0x30, r.length + s.length], r, s);
}

const UP = 0x01;
const UV = 0x04;
const AT = 0x40;

export type Opts = { origin: string; rpId: string; uv?: boolean; fmt?: string; x5c?: boolean; type?: string };

export class Authenticator {
  counter = 0;
  userHandle = "";
  private keys: CryptoKeyPair;
  readonly credId: Uint8Array;
  private constructor(keys: CryptoKeyPair, credId: Uint8Array) {
    this.keys = keys;
    this.credId = credId;
  }

  static async create() {
    const keys = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    return new Authenticator(keys, crypto.getRandomValues(new Uint8Array(32)));
  }

  get id() {
    return b64(this.credId);
  }

  private async sign(data: Uint8Array) {
    const raw = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, this.keys.privateKey, data as Uint8Array<ArrayBuffer>));
    return der(raw);
  }

  private async coseKey() {
    const raw = new Uint8Array((await crypto.subtle.exportKey("raw", this.keys.publicKey)) as ArrayBuffer);
    return isoCBOR.encode(new Map<number, number | Uint8Array>([[1, 2], [3, -7], [-1, 1], [-2, raw.slice(1, 33)], [-3, raw.slice(33, 65)]]));
  }

  /** Answer navigator.credentials.create() for these options (from the server). */
  async register(options: { challenge: string; user: { id: string } }, o: Opts) {
    this.userHandle = options.user.id;
    const clientData = enc.encode(JSON.stringify({ type: o.type ?? "webauthn.create", challenge: options.challenge, origin: o.origin, crossOrigin: false }));
    const flags = UP | AT | (o.uv === false ? 0 : UV);
    const cose = await this.coseKey();
    const authData = concat(
      await sha256(enc.encode(o.rpId)), [flags], [0, 0, 0, 0],
      new Uint8Array(16), [0, this.credId.length], this.credId, cose,
    );
    const fmt = o.fmt ?? "none";
    const attStmt = new Map<string, unknown>();
    if (fmt === "packed" || fmt === "fido-u2f") {
      attStmt.set("alg", -7);
      attStmt.set("sig", await this.sign(concat(authData, await sha256(clientData))));
      if (o.x5c) attStmt.set("x5c", [crypto.getRandomValues(new Uint8Array(64))]);
    }
    const attestationObject = isoCBOR.encode(new Map<string, unknown>([["fmt", fmt], ["attStmt", attStmt], ["authData", authData]]) as never);
    return {
      id: this.id, rawId: this.id, type: "public-key",
      response: { clientDataJSON: b64(clientData), attestationObject: b64(attestationObject), transports: ["internal"] },
      clientExtensionResults: {}, authenticatorAttachment: "platform",
    };
  }

  /** Answer navigator.credentials.get() for these options (from the server). */
  async authenticate(options: { challenge: string }, o: Opts) {
    this.counter += 1;
    const clientData = enc.encode(JSON.stringify({ type: o.type ?? "webauthn.get", challenge: options.challenge, origin: o.origin, crossOrigin: false }));
    const c = this.counter;
    const authData = concat(await sha256(enc.encode(o.rpId)), [UP | (o.uv === false ? 0 : UV)], [(c >>> 24) & 255, (c >>> 16) & 255, (c >>> 8) & 255, c & 255]);
    const signature = await this.sign(concat(authData, await sha256(clientData)));
    return {
      id: this.id, rawId: this.id, type: "public-key",
      response: { clientDataJSON: b64(clientData), authenticatorData: b64(authData), signature: b64(signature), userHandle: this.userHandle || undefined },
      clientExtensionResults: {}, authenticatorAttachment: "platform",
    };
  }
}
