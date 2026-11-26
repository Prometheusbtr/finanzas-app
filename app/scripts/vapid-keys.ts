// Makes the Web Push (VAPID) key pair for Finanzas' notifications. The private key is never printed.
//
//   node scripts/vapid-keys.ts --dev    local only: writes both keys into app/.dev.vars (git-ignored, mode 600)
//   node scripts/vapid-keys.ts --live   Melvin, in his own terminal, with CLOUDFLARE_API_TOKEN and
//                                       CLOUDFLARE_ACCOUNT_ID exported (README "Notifications"): puts the public key
//                                       into wrangler.production.jsonc and hands the private key straight to
//                                       `wrangler secret put VAPID_PRIVATE_KEY` on its standard input.
//
// Making new keys means every phone has to turn notifications on again (old subscriptions stop working).
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const APP = join(dirname(fileURLToPath(import.meta.url)), "..");
const mode = process.argv[2];
if (mode !== "--dev" && mode !== "--live") {
  console.error("Use --dev (local .dev.vars) or --live (production secret).");
  process.exit(1);
}

const b64u = (b: ArrayBuffer | Uint8Array) => Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString("base64url");
const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
const publicKey = b64u(await crypto.subtle.exportKey("raw", pair.publicKey));
const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
const privateKey = jwk.d!;
if (publicKey.length !== 87 || privateKey.length !== 43) throw new Error("unexpected key size");

if (mode === "--dev") {
  const file = join(APP, ".dev.vars");
  const keep = existsSync(file)
    ? readFileSync(file, "utf8").split("\n").filter((l) => l && !/^VAPID_(PUBLIC|PRIVATE)_KEY=/.test(l))
    : [];
  writeFileSync(file, [...keep, `VAPID_PUBLIC_KEY=${publicKey}`, `VAPID_PRIVATE_KEY=${privateKey}`].join("\n") + "\n", { mode: 0o600 });
  chmodSync(file, 0o600);
  console.log("Wrote both keys to app/.dev.vars (git-ignored). Public key:", publicKey);
} else {
  if (!process.stdin.isTTY) {
    console.error("Run this in your own terminal window, not through Claude or a pipe.");
    process.exit(1);
  }
  if (!process.env.CLOUDFLARE_API_TOKEN || !process.env.CLOUDFLARE_ACCOUNT_ID) {
    console.error("Export CLOUDFLARE_API_TOKEN (read -rs) and CLOUDFLARE_ACCOUNT_ID first (README).");
    process.exit(1);
  }
  const prod = join(APP, "wrangler.production.jsonc");
  const text = readFileSync(prod, "utf8");
  if (!/"VAPID_PUBLIC_KEY": *"[^"]*"/.test(text)) throw new Error("wrangler.production.jsonc has no VAPID_PUBLIC_KEY line");
  const put = spawnSync("npx", ["--no-install", "wrangler", "secret", "put", "VAPID_PRIVATE_KEY", "-c", "wrangler.production.jsonc"], {
    cwd: APP,
    input: privateKey,
    stdio: ["pipe", "inherit", "inherit"],
  });
  if (put.status !== 0) {
    console.error("wrangler secret put failed; nothing was changed in wrangler.production.jsonc.");
    process.exit(1);
  }
  writeFileSync(prod, text.replace(/"VAPID_PUBLIC_KEY": *"[^"]*"/, `"VAPID_PUBLIC_KEY": "${publicKey}"`));
  console.log("Secret saved. Public key written to wrangler.production.jsonc:", publicKey);
  console.log("Commit that file, then deploy (bash scripts/deploy.sh).");
}
