// Sign-up through an invite (#/unirse?c=<token>) and the Face ID reset link (#/restablecer?c=<token>).
// Both work without a session (PUBLIC in state.js). The token rides after "#", so it never reaches a server;
// it is read once and taken out of the address bar at once (history.replaceState), then kept in memory only.
// Three short screens: welcome (who invited her, privacy), her name, Face ID; then the backup code once.
import { S, app, tabs, ACT, PUBLIC } from "../state.js";
// The sign-up text is in the phone's language (es or en); the server stores it with her account.
import { t, locale } from "../i18n.js";
import { esc } from "../format.js";
import { api } from "../api.js";
import { toast } from "../ui.js";
import { icon } from "../look.js";
import { paint } from "../motion.js";
import { canPasskey, createPasskey, looksLikeBackupCode, passkeyError, passwordKey, PW_MIN } from "../passkey.js";

const flow = { token: null, kind: null, inviter: "", name: "", username: "", fails: 0, code: null };

/** Take the token out of the address bar (it stays in this page's memory only). */
function takeToken(params, path) {
  const c = params.get("c");
  if (c) {
    flow.token = c;
    history.replaceState(history.state, "", "#" + path);
  }
  return flow.token;
}

const phoneLang = () => ((navigator.language || "es").toLowerCase().startsWith("en") ? "en" : "es");

/** "María José Pérez" -> "mariajose": a username she can change (3 to 32 of a-z 0-9 . - _). */
function suggestUsername(name) {
  const words = name.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9 ._-]/g, "").trim().split(/\s+/);
  let u = words.slice(0, 2).join("").slice(0, 32);
  if (u.length < 3) u = (u + "123").slice(0, 3);
  return u;
}

function screen(step, html) {
  tabs.hidden = true;
  const dots = step ? `<p class="steps-dots" aria-label="${esc(t("suStepOf", { n: step }))}">${[1, 2, 3].map((n) => `<i class="${n <= step ? "on" : ""}"></i>`).join("")}</p>` : "";
  return paint(() => (app.innerHTML = `<div class="signup">${dots}${html}</div>`));
}

function invalid() {
  return screen(0, `<h1>${esc(t("suInvalidTitle"))}</h1><p class="lead">${esc(t("suInvalid"))}</p>
    <div class="btns"><a class="btn" href="#/">${esc(t("signIn"))}</a></div>`);
}

// ---------- 1. Bienvenida ----------
PUBLIC["/unirse"] = async (params) => {
  S.lang = phoneLang();
  document.documentElement.lang = S.lang;
  flow.kind = "signup";
  if (!takeToken(params, "/unirse")) return invalid();
  let inv;
  try {
    inv = await api("/invite", { method: "POST", body: { token: flow.token } });
  } catch (e) {
    if (e.code === "invite_invalid") return invalid();
    throw e;
  }
  flow.inviter = inv.inviter;
  await screen(1, `<h1>${esc(t("suWelcome"))}</h1>
    <p class="lead">${esc(t("suInvited", { name: inv.inviter }))}</p>
    <p>${esc(t("suWhat"))}</p>
    <div class="note-box">${icon("eye-off")}<div><p>${esc(t("suPrivacy"))}</p><p>${esc(t("suDelete"))}</p></div></div>
    <div class="note-box">${icon("face-id")}<div><p>${esc(t("suResetLine", { name: inv.inviter }))}</p></div></div>
    <div class="btns"><button class="btn primary block" type="button" data-act="suName">${esc(t("suStart"))}</button></div>`);
};

// ---------- 2. Tu nombre ----------
ACT.suName = () =>
  screen(2, `<h1>${esc(t("suNameTitle"))}</h1>
    <form data-submit="suNameSave" autocomplete="off">
      <label class="field"><span>${esc(t("suYourName"))}</span>
        <input name="display" maxlength="60" required autocomplete="given-name" value="${esc(flow.name)}"></label>
      <label class="field"><span>${esc(t("username"))}</span>
        <input name="username" maxlength="32" minlength="3" required pattern="[a-z0-9._\\-]{3,32}" autocapitalize="none" autocorrect="off" spellcheck="false" value="${esc(flow.username)}"></label>
      <p class="note">${esc(t("suUserHint"))}</p>
      <p class="err" id="suErr" hidden></p>
      <button class="btn primary block">${esc(t("suNext"))}</button>
    </form>`).then(() => {
    const form = app.querySelector("form");
    let touched = !!flow.username;
    form.username.addEventListener("input", () => (touched = true));
    form.display.addEventListener("input", () => {
      if (!touched) form.username.value = suggestUsername(form.display.value);
    });
    form.display.focus();
  });

let opts = null; // the last answer of /signup/options (Face ID options, ticket and password salt)
async function getOptions() {
  opts = await api("/signup/options", { method: "POST", body: { token: flow.token, username: flow.username, display_name: flow.name, lang: S.lang } });
  return opts;
}

ACT.suNameSave = async (form) => {
  const err = form.querySelector("#suErr");
  flow.name = form.display.value.trim();
  flow.username = form.username.value.trim().toLowerCase();
  const btn = form.querySelector("button");
  btn.disabled = true;
  try {
    await getOptions();
    await faceIdScreen();
  } catch (e) {
    err.hidden = false;
    err.textContent = e.code === "name_taken" ? t("suTaken") : e.code === "invite_invalid" ? t("suInvalid") : e.code && e.code.startsWith("invalid") ? t("suUserHint") : t("error", { e: e.code || "?" });
  } finally {
    btn.disabled = false;
  }
};

// ---------- 3. Face ID ----------
function faceIdScreen(msg) {
  const fallback = flow.fails > 0 || !canPasskey();
  return screen(3, `<h1>${esc(t("suFidTitle"))}</h1>
    <p class="lead">${esc(t("suFidBody"))}</p>
    <p class="err" id="suErr" ${msg ? "" : "hidden"}>${esc(msg || "")}</p>
    <div class="btns">${canPasskey() ? `<button class="btn primary block" type="button" data-act="suFid">${esc(t(flow.fails ? "suFidRetry" : "suFidGo"))}</button>` : ""}
    ${fallback ? `<button class="btn block" type="button" data-act="suPw">${esc(t("suUsePw"))}</button>` : ""}</div>`);
}

ACT.suFid = async (btn) => {
  btn.disabled = true;
  try {
    if (!opts) await getOptions();
    const response = await createPasskey(opts.options);
    opts = null; // used: the next try gets new options
    const r = await api("/signup", { method: "POST", body: { token: flow.token, response } });
    flow.code = r.backup_code;
    await doneScreen(true);
    flow.code = null; // only on the screen now (Copy reads it there); the reload after "Entrar" removes it
  } catch (e) {
    opts = null;
    flow.fails += 1;
    if (e.code === "invite_invalid") return invalid();
    await faceIdScreen(t(passkeyError(e)));
  }
};

// Her own password, when Face ID did not work (12 characters or more).
ACT.suPw = () =>
  screen(3, `<h1>${esc(t("suPwTitle"))}</h1>
    <form data-submit="suPwSave" novalidate>
      <input type="text" name="username" autocomplete="username" value="${esc(flow.username)}" hidden>
      <label class="field"><span>${esc(t("pwNew"))}</span><input name="pw" type="password" minlength="${PW_MIN}" required autocomplete="new-password"></label>
      <label class="field"><span>${esc(t("pwAgain"))}</span><input name="pw2" type="password" minlength="${PW_MIN}" required autocomplete="new-password"></label>
      <p class="note">${esc(t("pwHint", { n: PW_MIN }))}</p>
      <p class="err" id="suErr" hidden></p>
      <button class="btn primary block">${esc(t("suPwSave"))}</button>
    </form>
    <div class="btns">${canPasskey() ? `<button class="btn block" type="button" data-act="suFid">${esc(t("suFidRetry"))}</button>` : ""}</div>`);

/** Why a new password is refused, or "". */
export function pwProblem(pw, pw2) {
  if (pw.length < PW_MIN) return t("pwHint", { n: PW_MIN });
  if (pw !== pw2) return t("pwMismatch");
  if (looksLikeBackupCode(pw)) return t("pwLikeCode");
  return "";
}

ACT.suPwSave = async (form) => {
  const err = form.querySelector("#suErr");
  const problem = pwProblem(form.pw.value, form.pw2.value);
  if (problem) {
    err.hidden = false;
    err.textContent = problem;
    return;
  }
  const btn = form.querySelector("button");
  btn.disabled = true;
  btn.textContent = t("pwWorking");
  try {
    const o = await getOptions();
    const key = await passwordKey(form.pw.value, o.pw_salt, o.iter);
    const r = await api("/signup", { method: "POST", body: { token: flow.token, ticket: o.ticket, password_key: key } });
    flow.code = r.backup_code;
    await doneScreen(false);
    flow.code = null;
  } catch (e) {
    if (e.code === "invite_invalid") return invalid();
    err.hidden = false;
    err.textContent = t("error", { e: e.code || "?" });
    btn.disabled = false;
    btn.textContent = t("suPwSave");
  }
};

// ---------- done, then the backup code once ----------
function doneScreen(fid) {
  return screen(0, `<div class="success">${icon("check")}</div>
    <h1>${esc(t("suDoneTitle", { name: flow.name }))}</h1>
    <p class="lead">${esc(t(fid ? "suDoneFid" : "suDonePw"))}</p>
    <h2>${esc(t("codeTitle"))}</h2>
    ${codeBlock(flow.code)}
    <div class="btns"><button class="btn primary block" type="button" data-act="suEnter" data-code-next disabled>${esc(t("suEnter"))}</button></div>`);
}

/**
 * The backup code, shown once: Copy, and "Ya lo guardé" before going on. Used by Mi cuenta too.
 * The button marked data-code-next stays off until the box is ticked (wired by a change listener below;
 * the box has no data-act, since the click delegation would undo the tick).
 */
export function codeBlock(code) {
  return `<p>${esc(t("codeBody"))}</p>
    <p class="code num" id="codeText">${esc(code)}</p>
    <div class="btns"><button class="btn" type="button" data-act="copyCode">${esc(t("copy"))}</button></div>
    <label class="check"><input type="checkbox" id="codeSaved"> <span>${esc(t("codeSaved"))}</span></label>`;
}
document.addEventListener("change", (e) => {
  if (e.target.id !== "codeSaved") return;
  const next = document.querySelector("[data-code-next]");
  if (next) next.disabled = !e.target.checked;
});
ACT.copyCode = async () => {
  const el = document.getElementById("codeText");
  try {
    await navigator.clipboard.writeText(el.textContent);
    toast(t("copied"));
  } catch {
    getSelection().selectAllChildren(el);
  }
};
ACT.suEnter = () => {
  flow.code = null;
  flow.token = null;
  // A fresh page at Home: nothing of the sign-up (the code) stays in memory.
  history.replaceState(null, "", "#/");
  location.reload();
};

// ---------- Face ID reset link (made by the owner) ----------
PUBLIC["/restablecer"] = async (params) => {
  S.lang = phoneLang();
  flow.kind = "reset";
  if (!takeToken(params, "/restablecer")) return invalid();
  let who;
  try {
    who = await api("/reset", { method: "POST", body: { token: flow.token } });
  } catch (e) {
    if (e.code === "invite_invalid") return invalid();
    throw e;
  }
  if (who.pending) {
    // Its first 24 hours: nothing happens yet, only from when it works.
    const at = new Intl.DateTimeFormat(locale(), { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" })
      .format(new Date(who.usable_at)).replace(/\.$/, ""); // the sentence has its own period
    return screen(0, `<h1 data-reset-wait>${esc(t("rsNotYetTitle"))}</h1><p class="lead">${esc(t("rsNotYet", { x: at }))}</p>
      <div class="btns"><a class="btn" href="#/">${esc(t("signIn"))}</a></div>`);
  }
  flow.name = who.display_name;
  await resetScreen();
};
function resetScreen(msg) {
  return screen(0, `<h1>${esc(t("rsTitle", { name: flow.name }))}</h1>
    <p class="lead">${esc(t("rsBody"))}</p>
    <p class="err" id="suErr" ${msg ? "" : "hidden"}>${esc(msg || "")}</p>
    <div class="btns"><button class="btn primary block" type="button" data-act="rsGo">${esc(t("suFidGo"))}</button></div>`);
}
ACT.rsGo = async (btn) => {
  btn.disabled = true;
  try {
    const { options } = await api("/reset/options", { method: "POST", body: { token: flow.token } });
    const response = await createPasskey(options);
    await api("/reset/finish", { method: "POST", body: { token: flow.token, response } });
    flow.token = null;
    history.replaceState(null, "", "#/");
    location.reload();
  } catch (e) {
    if (e.code === "invite_invalid") return invalid();
    if (e.code === "reset_not_yet") return PUBLIC["/restablecer"](new URLSearchParams());
    await resetScreen(t(passkeyError(e)));
  }
};
