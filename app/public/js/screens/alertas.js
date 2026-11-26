// Funciones (Wave 2), Alertas: step 7 (#/pasos/alertas: one screen that explains, then the iPhone permission prompt,
// offered only when the app runs from the Home Screen, never by itself at first launch) and Ajustes → Alertas
// (#/ajustes/alertas: the switches, this phone on or off, a test). At most one notification a day, sent by the server
// at 7 pm; every alert is also a banner on Home. Texts never hold a shop, an amount or a name.
import { app, VIEWS, ACT, hooks } from "../state.js";
import { t } from "../i18n.js";
import { esc } from "../format.js";
import { api } from "../api.js";
import { toast, errText } from "../ui.js";
import { icon, tile } from "../look.js";
import { paint } from "../motion.js";
import { render } from "../router.js";
import { fnBack } from "./personas.js";

const standalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const canPush = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
const SWITCHES = ["lim80", "lim100", "card_due", "weekly", "cash"];

function keyBytes(b64u) {
  const s = atob(b64u.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((b64u.length + 3) % 4));
  return Uint8Array.from(s, (ch) => ch.charCodeAt(0));
}

/** Ask iOS, subscribe this phone and save the subscription (tied to this session). Returns true when on. */
async function turnOn(publicKey) {
  if (!publicKey) throw Object.assign(new Error("not_configured"), { code: "not_configured" });
  const asked = await Notification.requestPermission();
  if (asked !== "granted") return false;
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
  const j = sub.toJSON();
  await api("/push/subscription", { method: "POST", body: { endpoint: j.endpoint, keys: { p256dh: j.keys.p256dh, auth: j.keys.auth } } });
  return true;
}

/**
 * F29: once per page load, after sign-in: when this phone still holds a push subscription (alerts were on and not
 * turned off here) but the server has none for this session (a new session after a password, backup code or
 * Face ID change, or signing in again), send it again. Turning alerts off here also ends the subscription, so this
 * never turns them back on against her choice.
 */
let pushChecked = false;
hooks.keepPush = async () => {
  if (pushChecked || !canPush() || Notification.permission !== "granted") return;
  pushChecked = true;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = reg && (await reg.pushManager.getSubscription());
    if (!sub) return;
    const p = await api("/alerts/prefs");
    if (p.subscribed) return;
    const j = sub.toJSON();
    await api("/push/subscription", { method: "POST", body: { endpoint: j.endpoint, keys: { p256dh: j.keys.p256dh, auth: j.keys.auth } } });
  } catch {}
};

/**
 * Seguridad W3: signing out on this phone also ends this browser's push subscription, so keepPush never sends it
 * again for someone else who signs in here next (their alerts would come on without their choice). A session that
 * ends somewhere else (a change on another device, an expiry) keeps it, so the same person gets her alerts back.
 */
hooks.dropPush = async () => {
  if (!canPush()) return;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = reg && (await reg.pushManager.getSubscription());
    if (sub) await sub.unsubscribe();
  } catch {}
};

const pushErr = (e) => (e && e.code === "not_configured" ? t("fnPushNotReady") : e && e.code === "taken" ? t("fnPushTaken")
  : e && e.code === "too_many" ? t("fnPushTooMany") : errText(e)); // F45: too_many in words

// ---------- step 7 ----------
VIEWS["/pasos/alertas"] = async () => {
  const p = await api("/alerts/prefs");
  const ok = standalone() && canPush();
  await paint(() => (app.innerHTML = `${fnBack("/")}<h1>${esc(t("ps_alerts"))}</h1>
    <p class="lead">${esc(t("fnAlertsLead"))}</p>
    <ol class="guide">
      <li>${icon("credit-card")}<span>${esc(t("fnAlertCard"))}</span></li>
      <li>${icon("chart-bar")}<span>${esc(t("fnAlertLimit"))}</span></li>
      <li>${icon("calendar-due")}<span>${esc(t("fnAlertWeek"))}</span></li>
    </ol>
    <p class="note">${esc(t("fnAlertsOnce"))}</p>
    ${p.subscribed ? `<p class="note fn-on">${icon("check")}${esc(t("fnPushOnHere"))}</p>` : ok ? "" : `<p class="note">${esc(t(canPush() || !standalone() ? "fnNeedHomeScreen" : "fnNoPushHere"))}</p>`}
    <p class="err" id="fnErr" hidden></p>
    <div class="btns">
      ${p.subscribed ? `<button class="btn primary" type="button" data-act="psDone" data-step="alerts">${esc(t("fnDone"))}</button>`
        : ok ? `<button class="btn primary" type="button" data-act="fnPushOn" data-key="${esc(p.public_key || "")}" data-from="step">${icon("bell")}${esc(t("fnTurnOn"))}</button>`
        : `<a class="btn primary" href="#/pasos/inicio">${esc(t("ps_home_screen"))}</a>`}
      <button class="btn" type="button" data-act="psSkip" data-step="alerts">${esc(t("psNotNow"))}</button>
    </div>`));
};

ACT.fnPushOn = async (el) => {
  const err = document.getElementById("fnErr");
  el.disabled = true;
  try {
    const on = await turnOn(el.dataset.key);
    if (!on) {
      if (err) {
        err.textContent = t("fnPushDenied");
        err.hidden = false;
      }
      return;
    }
    if (el.dataset.from === "step") {
      await hooks.step("alerts", "done");
      toast(t("fnPushOn"));
      location.hash = "#/ajustes/alertas";
    } else {
      toast(t("fnPushOn"));
      render();
    }
  } catch (e) {
    if (err) {
      err.textContent = pushErr(e);
      err.hidden = false;
    } else toast(pushErr(e));
  } finally {
    el.disabled = false;
  }
};

// ---------- Ajustes → Alertas ----------
/** The row in Ajustes (js/screens/settings.js). */
export const alertsRow = () => `<h2>${esc(t("fnAlerts"))}</h2><div class="list grouped">
  <a class="row" data-pre href="#/ajustes/alertas">${tile("bell", "gray")}<span class="grow"><span class="title">${esc(t("fnAlerts"))}</span>
  <span class="sub">${esc(t("fnAlertsSub"))}</span></span><span class="side">${icon("chevron-right", "chev")}</span></a></div>`;

VIEWS["/ajustes/alertas"] = async () => {
  const p = await api("/alerts/prefs");
  const ok = standalone() && canPush();
  const rows = SWITCHES.map((k) => `<div class="row"><span class="grow"><span class="title">${esc(t("fnSw_" + k))}</span>
      <span class="sub">${esc(t("fnSw_" + k + "_sub"))}</span></span>
      <label class="switch"><input type="checkbox" data-fn-pref="${k}" ${p.prefs[k] ? "checked" : ""} aria-label="${esc(t("fnSw_" + k))}"><i aria-hidden="true"></i></label></div>`).join("");
  const phone = p.subscribed
    ? `<p class="note fn-on">${icon("check")}${esc(t("fnPushOnHere"))}</p>
       <div class="btns"><button class="btn" type="button" data-act="fnPushTest">${esc(t("fnPushTest"))}</button>
       <button class="btn" type="button" data-act="fnPushOff">${esc(t("fnPushOff"))}</button></div>`
    : ok ? `<p class="note">${esc(t("fnPushOffHere"))}</p><div class="btns"><button class="btn primary" type="button" data-act="fnPushOn" data-key="${esc(p.public_key || "")}">${icon("bell")}${esc(t("fnTurnOn"))}</button></div>`
    : `<p class="note">${esc(t(canPush() || !standalone() ? "fnNeedHomeScreen" : "fnNoPushHere"))}</p>`;
  await paint(() => (app.innerHTML = `${fnBack("/ajustes")}<h1>${esc(t("fnAlerts"))}</h1>
    <p class="lead">${esc(t("fnAlertsOnce"))}</p>
    <div class="list grouped fn-switches">${rows}</div>
    <h2>${esc(t("fnThisPhone"))}</h2>${phone}
    <p class="err" id="fnErr" hidden></p>
    <p class="note">${esc(t("fnBannersNote"))}</p>`));
};

document.addEventListener("change", async (e) => {
  const box = e.target.closest ? e.target.closest("[data-fn-pref]") : null;
  if (!box || !SWITCHES.includes(box.dataset.fnPref)) return;
  try {
    await api("/alerts/prefs", { method: "PUT", body: { [box.dataset.fnPref]: box.checked } });
    toast(t("saved"));
  } catch (err) {
    box.checked = !box.checked;
    toast(errText(err));
  }
});

ACT.fnPushTest = async () => {
  try {
    const r = await api("/push/test", { method: "POST" });
    // F45: "Prueba enviada" only when a push service took it; otherwise say so (alerts may need turning on again)
    if (r && r.ok === false) {
      toast(t("fnPushNotDelivered"));
      render();
    } else toast(t("fnPushSentTest"));
  } catch (e) {
    toast(e.code === "slow_down" ? t("fnPushSlow") : pushErr(e));
  }
};
ACT.fnPushOff = async () => {
  try {
    await api("/push/subscription", { method: "DELETE" });
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) await sub.unsubscribe();
    } catch {}
    toast(t("fnPushOffDone"));
    render();
  } catch (e) {
    toast(errText(e));
  }
};

// A tap on a notification while the app is open: the service worker names one of the fixed screens (sw.js OPEN).
const OPEN_HASH = { card: "#/mas/tarjetas", limit: "#/", week: "#/analisis?p=semana", cash: "#/agregar", home: "#/" };
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("message", (e) => {
    const d = e.data;
    if (!d || d.type !== "fz-open" || !Object.prototype.hasOwnProperty.call(OPEN_HASH, d.open)) return;
    if (location.hash !== OPEN_HASH[d.open]) location.hash = OPEN_HASH[d.open];
  });
}
