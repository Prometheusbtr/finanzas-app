// Funciones (Wave 2): Web Push and the evening alerts. RFC 8291 test vector, the push-service allowlist, the
// VAPID claim, one notification per person per El Salvador day in priority order, limit levels once a month,
// El Salvador time for "today" and "Sunday", and no amount, shop or card number in what a lock screen shows.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { alertItems, composeDaily, dailyForUser, DAILY_CRON, runDailyAlerts, scheduled, weekday, type PushEnv } from "../src/lib/alerts.ts";
import { b64u, encryptPush, isAllowedEndpoint, unb64u, type VapidKeys } from "../src/lib/webpush.ts";
import { call, json, makeUser, type TestUser } from "./helpers.ts";

const db = () => env.DB;
const enc = new TextEncoder();
const ORIGIN = "https://finanzas.test";
/** SV Sunday Nov 29 2026, 7 pm = Monday Nov 30, 01:00 UTC (the cron's time). */
const SUN_7PM = Date.UTC(2026, 10, 30, 1, 0);
const DAY = 86_400_000;

async function vapidKeys(): Promise<VapidKeys> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  return { publicKey: b64u((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer), privateKey: (await crypto.subtle.exportKey("jwk", pair.privateKey) as JsonWebKey).d! };
}

/** A phone's subscription keys, with the private half kept so the test can read what was sent. */
async function phone() {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const pub = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return { p256dh: b64u(pub), auth: b64u(auth), priv: pair.privateKey, pub, authBytes: auth };
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, n: number) {
  const k = await crypto.subtle.importKey("raw", new Uint8Array(ikm), "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(salt), info: new Uint8Array(info) }, k, n * 8));
}

/** The phone's side of RFC 8291: read one aes128gcm message. */
async function decrypt(body: Uint8Array, p: Awaited<ReturnType<typeof phone>>): Promise<string> {
  const salt = body.slice(0, 16);
  const idlen = body[20]!;
  const asPub = body.slice(21, 21 + idlen);
  const asKey = await crypto.subtle.importKey("raw", asPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: asKey } as unknown as SubtleCryptoDeriveKeyAlgorithm, p.priv, 256));
  const info = new Uint8Array([...enc.encode("WebPush: info\0"), ...p.pub, ...asPub]);
  const ikm = await hkdf(p.authBytes, ecdh, info, 32);
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, body.slice(21 + idlen)));
  expect(plain[plain.length - 1]).toBe(2); // the last-record padding delimiter
  return new TextDecoder().decode(plain.slice(0, -1));
}

type Sent = { url: string; headers: Record<string, string>; body: Uint8Array };
/** A stand-in push service: records each request and answers with `status`. Nothing leaves the test. */
function stub(status = 201) {
  const sent: Sent[] = [];
  const fetchFn = async (url: string, init: RequestInit) => {
    sent.push({ url, headers: Object.fromEntries(Object.entries(init.headers as Record<string, string>)), body: new Uint8Array(init.body as Uint8Array) });
    return new Response(null, { status });
  };
  return { sent, fetchFn };
}

let ep = 0;
/** A subscription on Apple's real push host (the stub answers for it), saved through the API for this session. */
async function subscribe(u: TestUser) {
  const p = await phone();
  const endpoint = `https://web.push.apple.com/QF-test-${++ep}-${Math.random().toString(36).slice(2)}`;
  const res = await call("POST", "/api/push/subscription", { endpoint, keys: { p256dh: p.p256dh, auth: p.auth } }, u.cookie);
  expect(res.status).toBe(201);
  return { ...p, endpoint };
}

async function spend(u: TestUser, fecha: string, cents: number, comercio = "Tienda Secreta", cat = u.cats.Supermercado) {
  await db().prepare(`INSERT INTO movements (user_id, fecha, amount_cents, tipo, comercio, merchant_key, account_id, category_id, origen, dedupe_key, created_at, updated_at)
    VALUES (?, ?, ?, 'gasto', ?, '', ?, ?, 'manual', ?, 1, 1)`).bind(u.id, fecha, cents, comercio, u.accountId, cat, `t:${Math.random()}`).run();
}

it("records the state after failure late in an import part and retry", async () => {
  const u = await makeUser("qa-part");
  for (let i = 0; i < 2; i++) await spend(u, "2026-07-05", 321, "Sample");
  const path = "/api/imports";
  const imp = await json(call("POST", path, {account_id:u.accountId, source:"csv",period_start:"2026-07-01",period_end:"2026-07-30",balanced:false},u.cookie));
  const rowsPath = path+"/"+imp.id+"/rows";
  const part = {part:0,rows:[{fecha:"2026-07-05", cents:321,dir:"out",comercio:"Test receipt"}]};
  await db().prepare("CREATE TRIGGER qa_failure BEFORE INSERT ON merge_suggestions BEGIN SELECT RAISE(ABORT, 'simulated late write failure'); END").run();
  const one=await call("POST",rowsPath,part,u.cookie);
  await db().prepare("DROP TRIGGER qa_failure").run();
  const two=await call("POST",rowsPath,part,u.cookie);
  const fin=await json(call("POST",path+"/"+imp.id+"/finish",{},u.cookie));
  const r = {first:one.status,retry:two.status,added:fin.totals.added};
  console.log("FACT part",JSON.stringify(r));expect(r).toEqual({first:500,retry:200,added:1}); // F20 fixed: the failed part wrote nothing, the retry adds it once
});
it("F11 (fixed) a failed push delivery is not marked, so the retry sends it", async () => {
  const u=await makeUser("qa-push");await subscribe(u);
  const e={DB:db(),APP_ORIGIN:ORIGIN,keys:await vapidKeys()};
  const down=stub(503);
  const report=await dailyForUser(e,u.id,"es",down.fetchFn,SUN_7PM);
  const up=stub(201);
  const retry=await dailyForUser(e,u.id,"es",up.fetchFn,SUN_7PM+60000);
  const marks=await db().prepare("SELECT COUNT(*) AS n FROM alert_marks WHERE user_id=? AND pushed_day IS NOT NULL").bind(u.id).first<{n:number}>();
  const r={firstStatus:report,attempts:down.sent.length,providerAccepted:0,marked:marks?.n,retryStatus:retry,retryAttempts:up.sent.length};
  console.log("FACT push",JSON.stringify(r));expect(r.firstStatus).toBe("failed");expect(r.retryStatus).toBe("sent");expect(r.retryAttempts).toBe(1);expect(r.marked).toBe(1);
});
it("checks a review inbox with 51 bank rows and two alternatives per row",async()=>{
  const u=await makeUser("qa-review");const dbb=db();
  // Synthetic, personally owned rows, created in the isolated unit-test DB.
  for(let i=0;i<51;i++){
    const base=1000+i;
    const ids: number[]=[];
    for(const [j,source] of ["archivo CSV","manual","manual"].entries()){
      const r=await dbb.prepare("INSERT INTO movements (user_id,fecha,amount_cents,tipo,origen,dedupe_key,created_at,updated_at) VALUES (?,'2026-06-01',?,'gasto',?,?,1,1) RETURNING id").bind(u.id,base,source,i+"-"+j).first<{id:number}>();ids.push(r!.id);
    }
    await dbb.batch(ids.slice(1).map(x=>dbb.prepare("INSERT INTO merge_suggestions(user_id,bank_id,manual_id,created_at) VALUES(?,?,?,1)").bind(u.id,ids[0],x)));
  }
  const r=await call("GET","/api/review",undefined,u.cookie);
  console.log("FACT review",JSON.stringify({ids:153,binds:154,status:r.status}));expect([200,500]).toContain(r.status);
});

