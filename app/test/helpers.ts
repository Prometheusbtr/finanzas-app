import { env } from "cloudflare:workers";
import app from "../src/index.ts";
import { hashPassphrase, newSalt, SESSION_COOKIE } from "../src/lib/auth.ts";

export const PASS = "abcde-fghjk-mnpqr-stuvw-xyz23";
/** Tests run as the live app does: over https, so the cookie is the __Host- one. */
export const BASE = "https://finanzas.test";
let n = 0;

export type TestUser = { id: number; username: string; cookie: string; accountId: number; otherAccountId: number; cats: Record<string, number> };

/** Insert a user with two accounts and a few categories, sign in, and return the session cookie. */
export async function makeUser(prefix = "u"): Promise<TestUser> {
  const username = `${prefix}${++n}${Math.random().toString(36).slice(2, 7)}`;
  const salt = newSalt();
  const db = env.DB;
  const u = await db
    .prepare("INSERT INTO users (username, display_name, pass_salt, pass_hash, lang, created_at) VALUES (?, ?, ?, ?, 'es', ?) RETURNING id")
    .bind(username, username, salt, await hashPassphrase(PASS, salt), Date.now())
    .first<{ id: number }>();
  const id = u!.id;
  const g = await db.prepare("INSERT INTO groups (user_id, name, limit_cents) VALUES (?, 'Comida', 50000) RETURNING id").bind(id).first<{ id: number }>();
  const cats: Record<string, number> = {};
  for (const [name, kind] of [["Supermercado", "E"], ["Café y snacks", "G"], ["Restaurantes", "G"]]) {
    const c = await db.prepare("INSERT INTO categories (user_id, group_id, name, kind) VALUES (?, ?, ?, ?) RETURNING id")
      .bind(id, g!.id, name, kind).first<{ id: number }>();
    cats[name] = c!.id;
  }
  const a1 = await db.prepare("INSERT INTO accounts (user_id, name) VALUES (?, 'BAC VISA 0000') RETURNING id").bind(id).first<{ id: number }>();
  const a2 = await db.prepare("INSERT INTO accounts (user_id, name, kind) VALUES (?, 'Efectivo', 'efectivo') RETURNING id").bind(id).first<{ id: number }>();
  const res = await login(username, PASS);
  if (res.status !== 200) throw new Error("login failed " + res.status);
  return { id, username, cookie: cookieOf(res), accountId: a1!.id, otherAccountId: a2!.id, cats };
}

export function cookieOf(res: Response, name = SESSION_COOKIE): string {
  const sc = res.headers.get("set-cookie") ?? "";
  const m = new RegExp(`(?:^|[;,]\\s*)${name.replace(/[-]/g, "\\-")}=([^;]+)`).exec(sc);
  return m ? `${name}=${m[1]}` : "";
}

/** A made-up client address per username, so each test user has its own login counters. */
export function ipFor(username: string): string {
  let h = 0;
  for (const ch of username) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `10.${(h >> 16) & 255}.${(h >> 8) & 255}.${h & 255}`;
}

export function login(username: string, passphrase: string, ip = ipFor(username)) {
  return call("POST", "/api/login", { username, passphrase }, undefined, { "cf-connecting-ip": ip });
}

/** Call the Worker's API as a browser would (JSON, same origin). */
export function call(method: string, path: string, body?: unknown, cookie?: string, headers: Record<string, string> = {}) {
  const h: Record<string, string> = { ...headers };
  if (cookie) h.cookie = cookie;
  if (method !== "GET" && !("content-type" in h)) h["content-type"] = "application/json";
  const url = /^https?:/.test(path) ? path : `${BASE}${path}`;
  return app.request(url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }, env);
}

export async function json<T = any>(res: Response | Promise<Response>): Promise<T> {
  return (await res).json() as Promise<T>;
}

/** As if this session had just passed a Face ID (or password) check: the X-FZ-Unlock header to send. The sensitive
 * changes in Mi cuenta need one made in the last 5 minutes (requireFresh). ageMs makes an older one. */
export async function freshProof(cookie: string, ageMs = 0, method: "passkey" | "password" | "passphrase" = "passkey"): Promise<Record<string, string>> {
  const token = decodeURIComponent(cookie.slice(cookie.indexOf("=") + 1));
  const proof = `fresh-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
  const hex = async (s: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))]
    .map((b) => b.toString(16).padStart(2, "0")).join("");
  await env.DB.prepare("UPDATE sessions SET unlock_hash = ?, unlocked_at = ?, unlock_method = ? WHERE token_hash = ?")
    .bind(await hex(proof), Date.now() - ageMs, method, await hex(token)).run();
  return { "x-fz-unlock": proof };
}
