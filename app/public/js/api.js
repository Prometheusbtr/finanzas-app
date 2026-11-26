// Calls to /api/* on the same Worker.
import { S, hooks, memo } from "./state.js";

/** Forget every screen kept in memory (js/data.js cached), and make loads already running keep nothing. */
export function forget() {
  memo.map.clear();
  memo.gen += 1;
}

export class ApiError extends Error {
  constructor(code, status, data) {
    super(code);
    this.code = code;
    this.status = status;
    this.data = data;
  }
}
let hadSession = false; // a call worked in this page, so a later 401 means a session ended while the app was open
/** True once this page has had a session (the login screen reloads such a page for the next person). */
export const pageHadSession = () => hadSession;

// Other tabs of the app share the cookie but not this page's memory. When a sign in or sign out here changes
// whose session the cookie holds, they reload, so none of them keeps showing the last person's screens.
const tabsChannel = typeof BroadcastChannel === "function" ? new BroadcastChannel("fz-session") : null;
if (tabsChannel) tabsChannel.onmessage = () => location.reload();

export async function api(path, opts = {}) {
  const method = opts.method || "GET";
  const init = { method, credentials: "same-origin", headers: {} };
  if (S.unlock) init.headers["X-FZ-Unlock"] = S.unlock; // the Face ID lock's proof (page memory only)
  if (method !== "GET") {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(opts.body || {});
    // A save, edit, delete, categorize, sign in or sign out changes what the screens show: forget them now, and
    // again when the answer comes (a screen load that ran alongside may hold the old numbers), even on an error.
    forget();
  }
  let res;
  try {
    res = await fetch("/api" + path, init);
  } catch {
    throw new ApiError("offline", 0);
  } finally {
    if (method !== "GET") forget();
  }
  let data = null;
  try {
    data = await res.json();
  } catch {}
  if (res.status === 401 && !path.startsWith("/login")) {
    // The session is gone: drop the screens kept in memory, and make every load still on its way stale
    // (S.nav), so an answer for this user that arrives late draws nothing over the login form.
    S.boot = null;
    forget();
    S.nav += 1;
    if (hooks.authLost) hooks.authLost(hadSession);
    throw new ApiError("auth", 401, data);
  }
  if (res.status === 423) {
    // The Face ID lock is on and this page has no fresh proof: drop what the page holds, show the lock.
    S.unlock = null;
    S.boot = null;
    forget();
    S.nav += 1;
    if (hooks.locked) hooks.locked();
    throw new ApiError("unlock", 423, data);
  }
  if (res.status === 403 && data && data.error === "reauth" && hooks.reauth && !opts.reauthed) {
    // A sensitive change (new backup code, password, Face ID, deleting the account, cancelling a reset link) needs
    // a fresh Face ID or password check (the server says which): ask for it, then send this request once more.
    if (await hooks.reauth(data.method)) return api(path, { ...opts, reauthed: true });
    throw new ApiError("reauth_cancelled", 403, data);
  }
  if (!res.ok) throw new ApiError((data && data.error) || "http_" + res.status, res.status, data);
  hadSession = true;
  if (tabsChannel && changesSession(method, path)) tabsChannel.postMessage(1);
  return data;
}

/** Calls after which the cookie holds a new session, or none (a login-method change ends the others). */
function changesSession(method, path) {
  if (method === "GET") return false;
  if (/^\/(login|login\/password|login\/passkey|logout|logout-all|signup|reset\/finish|me\/password|me\/backup-code)$/.test(path)) return true;
  if (path === "/passkeys" || /^\/passkeys\/\d+$/.test(path)) return true;
  return method === "DELETE" && path === "/me";
}
