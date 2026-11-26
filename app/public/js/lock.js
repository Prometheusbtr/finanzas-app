// Face ID lock (Primeros pasos, step 8). The server enforces it: while the lock is on, every money route
// answers 423 until this page shows the proof from a fresh Face ID check (X-FZ-Unlock, see api.js).
// The proof lives in S.unlock, page memory only: a reload drops it, and so does about 5 minutes hidden.
import { S, app, sheet, tabs, ACT, hooks } from "./state.js";
import { t } from "./i18n.js";
import { esc } from "./format.js";
import { api, forget } from "./api.js";
import { render } from "./router.js";
import { passkeyError, passwordKey, unlockWithPasskey } from "./passkey.js";
import { errText, openSheet, tn } from "./ui.js";
import { icon } from "./look.js";

const HIDDEN_MS = 5 * 60 * 1000;
let lockOn = false; // the server said the lock is on (a 423, or turning it on here)
let hiddenAt = 0;

/** Remember that the lock is on or off, and the proof from the last Face ID check. */
export function setLock(on, proof) {
  lockOn = !!on;
  if (proof !== undefined) S.unlock = proof || null;
}

export function viewLock(msg) {
  lockOn = true;
  tabs.hidden = true;
  if (sheet.open) sheet.close();
  app.innerHTML = `<div class="login lockscreen">
    <img class="logo" src="/icons/icon-192.png" alt="">
    <h1>${esc(t("lockTitle"))}</h1>
    <p class="note">${esc(t("lockBody"))}</p>
    <p class="err" id="lockErr" ${msg ? "" : "hidden"}>${esc(msg || "")}</p>
    <button class="btn primary block" type="button" data-act="unlockNow">${esc(t("lockOpen"))}</button>
    <button class="btn block" type="button" data-act="lockSignOut">${esc(t("signOut"))}</button>
  </div>`;
}
hooks.locked = () => viewLock();

ACT.unlockNow = async (btn) => {
  btn.disabled = true;
  try {
    const r = await unlockWithPasskey(false);
    setLock(r.app_lock, r.unlock);
    S.boot = null;
    await render();
  } catch (e) {
    if (e.code === "unlock") return; // the lock screen is already up again
    const err = document.getElementById("lockErr");
    if (err) {
      err.hidden = false;
      err.textContent = t(passkeyError(e));
    }
  } finally {
    btn.disabled = false;
  }
};
ACT.lockSignOut = async () => {
  try {
    await api("/logout", { method: "POST" });
  } catch {}
  await hooks.dropPush?.(); // Seguridad W3: the next person here never gets her alerts
  S.unlock = null;
  location.reload();
};

// About 5 minutes in the background: forget the proof and what the page shows, and ask for Face ID again.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    hiddenAt = Date.now();
    return;
  }
  if (!lockOn || !hiddenAt || Date.now() - hiddenAt < HIDDEN_MS) return;
  hiddenAt = 0;
  S.unlock = null;
  S.boot = null;
  forget();
  S.nav += 1;
  viewLock();
});

// ---------- Fresh check (Melvin's decision, Nov 25 2026) ----------
// Before a sensitive change the server answers 403 {"error":"reauth","method"} unless this page holds a proof from
// the last 5 minutes. api.js then calls hooks.reauth: a sheet asks for Face ID (a tap first, as iPhone wants), or,
// for someone without Face ID, the password or passphrase again. True when the check worked; false when she closed
// the sheet (the change is then not made). The new proof stays in page memory only, like the lock's.
let reauthDone = null;
hooks.reauth = (method) =>
  new Promise((resolve) => {
    const done = (ok) => {
      if (reauthDone !== done) return;
      reauthDone = null;
      resolve(ok);
    };
    reauthDone = done;
    const fid = method === "passkey";
    const pw = method === "password";
    openSheet(t("raTitle"), fid
      ? `<p>${esc(t("raFidBody"))}</p><p class="err" id="raErr" hidden></p>
        <div class="btns"><button class="btn primary" type="button" data-act="raFid">${icon("face-id")}${esc(t("raFidGo"))}</button></div>`
      : `<form data-submit="raPw" data-method="${pw ? "password" : "passphrase"}" novalidate>
        <p>${esc(t(pw ? "raPwBody" : "raPassBody"))}</p>
        <input type="text" name="username" autocomplete="username" value="${esc(S.boot ? S.boot.user.username : "")}" hidden>
        <label class="field"><span>${esc(t(pw ? "raPwLabel" : "raPassLabel"))}</span>
          <input name="pw" type="password" required autocomplete="current-password" autocapitalize="none" autocorrect="off" spellcheck="false"></label>
        <p class="err" id="raErr" hidden></p>
        <div class="btns"><button class="btn primary">${esc(t("raGo"))}</button></div></form>`);
    sheet.addEventListener("close", () => done(false), { once: true });
  });

function raError(msg) {
  const err = document.getElementById("raErr");
  if (!err) return;
  err.hidden = false;
  err.textContent = msg;
}
ACT.raFid = async (btn) => {
  btn.disabled = true;
  try {
    const r = await unlockWithPasskey(false);
    setLock(lockOn || r.app_lock, r.unlock);
    if (reauthDone) reauthDone(true);
  } catch (e) {
    raError(t(passkeyError(e)));
    btn.disabled = false;
  }
};
ACT.raPw = async (form) => {
  const btn = form.querySelector("button");
  btn.disabled = true;
  try {
    let body;
    if (form.dataset.method === "password") {
      const { salt, iter } = await api("/me/password/salt", { method: "POST" });
      body = { key: await passwordKey(form.pw.value, salt, iter) };
    } else body = { passphrase: form.pw.value };
    const r = await api("/reauth", { method: "POST", body });
    S.unlock = r.unlock;
    if (reauthDone) reauthDone(true);
  } catch (e) {
    raError(e.code === "bad_password" ? tn("raBad", e.data.tries_left)
      : e.code === "locked" || e.code === "slow_down" ? t("locked", { m: Math.ceil(e.data.retry_after_s / 60) }) : errText(e));
    btn.disabled = false;
  }
};
