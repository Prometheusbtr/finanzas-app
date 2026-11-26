// Sign-in screen.
import { S, app, sheet, tabs, ACT, hooks } from "../state.js";
import { t } from "../i18n.js";
import { esc } from "../format.js";
import { api, pageHadSession } from "../api.js";
import { errText, tn } from "../ui.js";
import { render } from "../router.js";
import { canPasskey, looksLikeBackupCode, passkeyError, passwordKey, usePasskey } from "../passkey.js";
import { setLock } from "../lock.js";

export function viewLogin(msg) {
  tabs.hidden = true;
  if (sheet.open) sheet.close();
  app.innerHTML = `<form class="login" data-submit="login" autocomplete="on">
    <img class="logo" src="/icons/icon-192.png" alt="">
    <h1>Finanzas</h1>
    <label class="field"><span>${esc(t("username"))}</span>
      <input name="username" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" required></label>
    <label class="field"><span>${esc(t("passOrCode"))}</span>
      <input name="password" type="password" autocomplete="current-password" autocapitalize="none" autocorrect="off" spellcheck="false" required></label>
    <p class="err" id="loginErr" ${msg ? "" : "hidden"}>${esc(msg || "")}</p>
    <button class="btn primary block">${esc(t("signIn"))}</button>
  </form>
  ${canPasskey() ? `<div class="login-alt"><button class="btn block" type="button" data-act="loginPasskey">${esc(t("signInFid"))}</button></div>` : ""}`;
}

/**
 * After any sign-in: a fresh page when this one had a session before the sign-in started (reloadAfter), else
 * Home (or the new Face ID screen after the backup code). A reload drops the Face ID lock's proof (page memory
 * only), so with the lock on that page asks for Face ID once more.
 */
async function signedIn(r, reloadAfter) {
  setLock(!!r.unlock, r.unlock || r.fresh); // fresh: after the backup code, to add a Face ID again (lock off)
  const to = r.backup_used ? "#/ajustes/faceid" : "#/";
  if (reloadAfter) {
    history.replaceState(null, "", to);
    location.reload();
    return;
  }
  S.boot = null;
  location.hash = to;
  await render();
}

// One field for the passphrase or backup code (the app-made 25 characters) and her own password (anything else).
// The password goes through PBKDF2 here first; only the result is sent.
async function signIn(username, secret) {
  if (looksLikeBackupCode(secret)) return api("/login", { method: "POST", body: { username, passphrase: secret } });
  const { salt, iter } = await api("/login/salt", { method: "POST", body: { username } });
  return api("/login/password", { method: "POST", body: { username, key: await passwordKey(secret, salt, iter) } });
}

ACT.loginPasskey = async (btn) => {
  const err = document.getElementById("loginErr");
  btn.disabled = true;
  const reloadAfter = pageHadSession(); // before the calls below, which count as having a session
  try {
    const { options } = await api("/login/passkey/options", { method: "POST" });
    const response = await usePasskey(options);
    await signedIn(await api("/login/passkey", { method: "POST", body: { response } }), reloadAfter);
  } catch (e) {
    err.hidden = false;
    err.textContent = e.code === "slow_down" ? t("locked", { m: Math.ceil(e.data.retry_after_s / 60) }) : t(passkeyError(e));
  } finally {
    btn.disabled = false;
  }
};
ACT.login = async (form) => {
  const err = form.querySelector("#loginErr");
  const btn = form.querySelector("button");
  btn.disabled = true;
  // One person's session per page. If this page already had one (it ended and the reload after authLost has
  // not come yet), the new session starts on a fresh page at Home, so nothing of the last person stays in
  // memory (Home's count-up, filters, the list) and their last screen is not reopened.
  const reloadAfter = pageHadSession();
  try {
    await signedIn(await signIn(form.username.value, form.password.value), reloadAfter);
  } catch (e) {
    err.hidden = false;
    if (e.code === "bad_login") err.textContent = tn("badLogin", e.data.tries_left);
    else if (e.code === "locked" || e.code === "slow_down") err.textContent = t("locked", { m: Math.ceil(e.data.retry_after_s / 60) });
    else err.textContent = errText(e);
  } finally {
    btn.disabled = false;
  }
};
// A session that ends while the app is open (it ran out, "sign out everywhere", the owner's tool, a new
// passphrase): the form at once, then a reload, as Sign out does, so nothing of this user stays in memory
// for whoever signs in next (Home's count-up starts from the last number it showed). A page that never had
// a session only shows the form, so the reload cannot loop.
hooks.authLost = (hadSession) => {
  viewLogin();
  if (hadSession) location.reload();
};
