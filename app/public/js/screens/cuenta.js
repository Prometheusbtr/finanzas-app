// Ajustes → Mi cuenta (#/ajustes/cuenta), Face ID again after the backup code (#/ajustes/faceid) and, for the
// owner, Personas en la app (#/ajustes/personas). No route here returns or shows amounts of anyone.
// Every name goes through esc(); every write through api(). Calls that change how she signs in end her other
// sessions on the server and hand this device a new cookie (and a new lock proof when the lock is on).
import { S, app, sheet, VIEWS, ACT, hooks } from "../state.js";
import { t, locale } from "../i18n.js";
import { esc } from "../format.js";
import { api } from "../api.js";
import { toast, errText, formError, backBtn, openSheet, closeSheet } from "../ui.js";
import { paint } from "../motion.js";
import { icon, tile } from "../look.js";
import { render } from "../router.js";
import { addPasskey, canPasskey, passkeyError, passwordKey, PW_MIN } from "../passkey.js";
import { setLock } from "../lock.js";
import { codeBlock, pwProblem } from "./signup.js";

/** "25 nov, 14:05" (or only the date when it is not this year). ms: a server timestamp. */
function when(ms) {
  if (!ms) return "—";
  const d = new Date(ms);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return new Intl.DateTimeFormat(locale(), sameYear ? { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" } : { day: "numeric", month: "short", year: "numeric" }).format(d);
}
/** The same date for the middle of a sentence that ends with its own period ("6:48 p. m." would show "p. m.."). */
const whenDot = (ms) => when(ms).replace(/\.$/, "");

/** "25 nov" (with the year when it is not this year). */
function day(ms) {
  if (!ms) return "—";
  const d = new Date(ms);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return new Intl.DateTimeFormat(locale(), sameYear ? { day: "numeric", month: "short" } : { day: "numeric", month: "short", year: "numeric" }).format(d);
}

/** The rows Ajustes shows for this module (one each). */
export function accountRows() {
  const row = (href, ic, title, sub) =>
    `<a class="row" href="${href}">${tile(ic, "gray")}<span class="grow"><span class="title">${esc(title)}</span><span class="sub">${esc(sub)}</span></span>${icon("chevron-right", "chev")}</a>`;
  return `<h2>${esc(t("cuAccountH"))}</h2><div class="list grouped">
    ${row("#/ajustes/cuenta", "face-id", t("cuMine"), t("cuMineSub"))}
    ${S.boot.user.is_owner ? row("#/ajustes/personas", "users-group", t("cuPeople"), t("cuPeopleSub")) : ""}</div>`;
}

/** After a call that gave this device a new session: keep the new proof, and the lock as the server says it is
 * (F28: a proof alone never turns the lock on; removing the last Face ID turns it off). */
function newSession(r) {
  if (r && r.unlock !== undefined) setLock(r.app_lock === undefined ? !!r.unlock : !!r.app_lock, r.unlock);
}

// ---------- Mi cuenta ----------
VIEWS["/ajustes/cuenta"] = async () => {
  const a = await api("/account");
  const setup = await api("/setup");
  const sessions = a.sessions.map((s) => `<div class="row">${tile("device-mobile", "gray")}<span class="grow">
      <span class="title">${esc(s.label || t("cuDevice"))}${s.current ? ` <span class="pchip">${esc(t("cuThis"))}</span>` : ""}</span>
      <span class="sub">${esc(t("cuLastUsed", { x: when(s.last_used) }))}</span></span>
      ${s.current ? "" : `<button class="btn small" type="button" data-act="cuEndSession" data-id="${esc(s.id)}">${esc(t("cuSignOutOne"))}</button>`}</div>`).join("");
  const passkeys = a.passkeys.map((p) => `<div class="row">${tile("face-id", "gray")}<span class="grow">
      <span class="title">${esc(p.label || "Face ID")}</span>
      <span class="sub">${p.counts === 0 ? esc(t("cuFidStale")) : esc(t("cuAdded", { x: when(p.created_at) })) + (p.last_used_at ? " · " + esc(t("cuLastUsed", { x: when(p.last_used_at) })) : "")}</span></span>
      <button class="btn small" type="button" data-act="cuDelPasskey" data-id="${Number(p.id)}">${esc(t("remove"))}</button></div>`).join("");
  await paint(() => (app.innerHTML = `${backBtn(["/ajustes"])}<h1>${esc(t("cuMine"))}</h1>
    <p class="lead">${esc(S.boot.user.display_name)} · <span class="muted">${esc(S.boot.user.username)}</span></p>
    ${backupNotice(a)}
    ${resetNotice(a)}
    <h2>Face ID</h2>
    ${passkeys ? `<div class="list grouped">${passkeys}</div>` : `<p class="note">${esc(t("cuNoFid"))}</p>`}
    <div class="btns">${canPasskey() ? `<button class="btn" type="button" data-act="cuAddPasskey">${icon("plus")}${esc(t("cuAddFid"))}</button>` : ""}
      <a class="btn" href="#/pasos/bloqueo">${icon("lock")}${esc(t(a.app_lock ? "cuLockOn" : "cuLockOff"))}</a></div>
    <h2>${esc(t("cuSignInH"))}</h2>
    <div class="list grouped">
      <button class="row" type="button" data-act="cuPassword"><span class="grow"><span class="title">${esc(t(a.has_password ? "cuPwChange" : "cuPwCreate"))}</span>
        <span class="sub">${esc(t("cuPwSub", { n: PW_MIN }))}</span></span>${icon("chevron-right", "chev")}</button>
      <button class="row" type="button" data-act="cuNewCode"><span class="grow"><span class="title">${esc(t("cuNewCode"))}</span>
        <span class="sub">${esc(t("cuNewCodeSub"))}</span></span>${icon("chevron-right", "chev")}</button>
    </div>
    <h2>${esc(t("cuSessionsH"))}</h2>
    <div class="list grouped">${sessions}</div>
    <div class="btns"><button class="btn" type="button" data-act="cuEndAll">${esc(t("cuSignOutAll"))}</button></div>
    <h2>${esc(t("psTitle"))}</h2>
    <div class="btns"><button class="btn" type="button" data-act="cuCard" data-v="${setup.card === "hidden" ? 0 : 1}">${esc(t(setup.card === "hidden" ? "cuCardShow" : "cuCardHide"))}</button></div>
    <h2>${esc(t("cuDataH"))}</h2>
    <div class="btns"><button class="btn" type="button" data-act="exportCsv">${esc(t("export"))}</button></div>
    ${a.is_owner ? `<p class="note">${esc(t("cuOwnerNoDelete"))}</p>`
      : `<div class="btns"><button class="btn danger" type="button" data-act="cuDeleteMe">${esc(t("cuDelete"))}</button></div>`}`));
};

/**
 * A Face ID reset link for her that is still open (Melvin's decision, Nov 25 2026): who made it, from when it works,
 * and "Cancelar" (which asks for a fresh Face ID check). Home and Mi cuenta both show it.
 */
export function resetBanner(list) {
  if (!list || !list.length) return "";
  return list.map((r) => `<div class="note-box warn" role="status">${icon("face-id")}<div>
      <p>${esc(r.usable_at > Date.now() ? t("rpBanner", { by: r.by, made: whenDot(r.made_at), x: whenDot(r.usable_at) })
        : t("rpBannerLive", { by: r.by, made: whenDot(r.made_at), x: whenDot(r.expires_at) }))}</p>
      <p>${esc(t("rpAsk"))}</p>
      <p><button class="btn small" type="button" data-act="rpCancel" data-id="${Number(r.id)}">${esc(t("rpCancel"))}</button></p></div></div>`).join("");
}
ACT.rpCancel = async (btn) => {
  btn.disabled = true;
  try {
    await api(`/me/resets/${Number(btn.dataset.id)}`, { method: "DELETE" });
    closeSheet();
    toast(t("rpCancelled"));
    S.boot = null;
    await render();
  } catch (e) {
    toast(errText(e));
    btn.disabled = false;
  }
};

/**
 * Face ID reset links the owner made for her (Seguridad, Nov 25 2026): every one, open, used, cancelled (by whom)
 * or expired. Whoever holds such a link can add a Face ID to her account, so nothing in the app hides them.
 */
function resetNotice(a) {
  if (!a.resets || !a.resets.length) return "";
  const line = (r) => {
    const v = { by: r.by, made: whenDot(r.made_at) };
    if (r.status === "used") return t("cuResetUsed", { ...v, used: when(r.used_at) });
    if (r.status === "cancelled") {
      if (r.cancelled_by === "self") return t("cuResetCancelSelf", { ...v, x: whenDot(r.cancelled_at) });
      if (r.cancelled_by === "replaced") return t("cuResetReplaced", v);
      return t("cuResetCancelOwner", { ...v, x: whenDot(r.cancelled_at) });
    }
    if (r.status === "expired") return t("cuResetExpired", { ...v, x: when(r.expires_at) });
    return "";
  };
  const done = a.resets.filter((r) => r.status !== "pending").map((r) => `<p>${esc(line(r))}</p>`).join("");
  return `<h2 data-resets>${esc(t("cuResetsH"))}</h2>${resetBanner(a.resets.filter((r) => r.status === "pending"))}
    ${done ? `<div class="note-box">${icon("face-id")}<div>${done}<p>${esc(t("cuResetWarn"))}</p></div></div>` : ""}`;
}

/** After a sign-in with the backup code: Face ID again, before anything else. */
function backupNotice(a) {
  const after = a.backup_used_at && !a.passkeys.some((p) => p.created_at > a.backup_used_at);
  return after ? `<div class="note-box warn">${icon("lock")}<div><p>${esc(t("cuBackupUsed"))}</p>
    <p><a href="#/ajustes/faceid">${esc(t("cuAddFid"))}</a></p></div></div>` : "";
}

// ---------- Face ID again (after the backup code) ----------
VIEWS["/ajustes/faceid"] = async () => {
  const a = await api("/account");
  const old = a.passkeys.map((p) => `<div class="row">${tile("face-id", "gray")}<span class="grow"><span class="title">${esc(p.label || "Face ID")}</span>
      <span class="sub">${esc(t("cuAdded", { x: when(p.created_at) }))}</span></span>
      <button class="btn small" type="button" data-act="cuDelPasskey" data-id="${Number(p.id)}">${esc(t("remove"))}</button></div>`).join("");
  await paint(() => (app.innerHTML = `${backBtn(["/ajustes", "/"])}<h1>${esc(t("cuFidAgain"))}</h1>
    <p class="lead">${esc(t("cuFidAgainBody"))}</p>
    ${resetNotice(a)}
    <p class="err" id="fidErr" hidden></p>
    <div class="btns">${canPasskey() ? `<button class="btn primary" type="button" data-act="cuAddPasskey" data-then="home">${icon("face-id")}${esc(t("cuAddFid"))}</button>` : ""}
      <a class="btn" href="#/">${esc(t("psNotNow"))}</a></div>
    ${old ? `<h2>${esc(t("cuOldFid"))}</h2><p class="note">${esc(t("cuOldFidNote"))}</p><div class="list grouped">${old}</div>` : ""}`));
};

ACT.cuAddPasskey = async (btn) => {
  btn.disabled = true;
  try {
    const unlock = await addPasskey();
    newSession({ unlock });
    toast(t("cuFidAdded"));
    if (btn.dataset.then === "home") location.hash = "#/";
    else await render();
  } catch (e) {
    const err = document.getElementById("fidErr");
    if (err) {
      err.hidden = false;
      err.textContent = t(passkeyError(e));
    } else toast(t(passkeyError(e)));
    btn.disabled = false;
  }
};
ACT.cuDelPasskey = (el) =>
  openSheet(t("cuDelFidTitle"), `<p>${esc(t("cuDelFidBody"))}</p>
    <div class="btns"><button class="btn danger" type="button" data-act="cuDelPasskeyGo" data-id="${Number(el.dataset.id)}">${esc(t("remove"))}</button></div>`);
ACT.cuDelPasskeyGo = async (el) => {
  try {
    newSession(await api(`/passkeys/${Number(el.dataset.id)}`, { method: "DELETE" }));
    closeSheet();
    await render();
  } catch (e) {
    toast(errText(e));
  }
};

ACT.cuEndSession = async (el) => {
  try {
    await api(`/sessions/${encodeURIComponent(el.dataset.id)}`, { method: "DELETE" });
    toast(t("cuSignedOutOne"));
    await render();
  } catch (e) {
    toast(errText(e));
  }
};
ACT.cuEndAll = () =>
  openSheet(t("cuSignOutAll"), `<p>${esc(t("cuSignOutAllBody"))}</p>
    <div class="btns"><button class="btn danger" type="button" data-act="cuEndAllGo">${esc(t("cuSignOutAll"))}</button></div>`);
ACT.cuEndAllGo = async () => {
  try {
    await api("/logout-all", { method: "POST" });
  } catch {}
  await hooks.dropPush?.(); // Seguridad W3: the next person here never gets her alerts
  S.unlock = null;
  location.reload();
};

ACT.cuCard = async (el) => {
  try {
    await api("/setup/card", { method: "PUT", body: { hidden: el.dataset.v === "1" } });
    toast(t(el.dataset.v === "1" ? "psHidden" : "cuCardShown"));
    await render();
  } catch (e) {
    toast(errText(e));
  }
};

// Her own password (12+ characters). PBKDF2 runs here with a new salt from the server; only the result is sent.
ACT.cuPassword = () =>
  openSheet(t("cuPwTitle"), `<form data-submit="cuPwSave" novalidate>
    <input type="text" name="username" autocomplete="username" value="${esc(S.boot.user.username)}" hidden>
    <label class="field"><span>${esc(t("pwNew"))}</span><input name="pw" type="password" minlength="${PW_MIN}" required autocomplete="new-password"></label>
    <label class="field"><span>${esc(t("pwAgain"))}</span><input name="pw2" type="password" minlength="${PW_MIN}" required autocomplete="new-password"></label>
    <p class="note">${esc(t("cuPwNote"))}</p>
    <p class="err" id="pwErr" hidden></p>
    <div class="btns"><button class="btn primary">${esc(t("save"))}</button></div></form>`);
ACT.cuPwSave = async (form) => {
  const err = form.querySelector("#pwErr");
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
    const { salt, iter } = await api("/me/password/salt", { method: "POST" });
    newSession(await api("/me/password", { method: "PUT", body: { salt, key: await passwordKey(form.pw.value, salt, iter) } }));
    closeSheet();
    toast(t("saved"));
    await render();
  } catch (e) {
    formError(form, err, errText(e));
    btn.disabled = false;
    btn.textContent = t("save");
  }
};

// A new backup code: the old one stops working. Shown once.
ACT.cuNewCode = () =>
  openSheet(t("cuNewCode"), `<p>${esc(t("cuNewCodeBody"))}</p>
    <div class="btns"><button class="btn primary" type="button" data-act="cuNewCodeGo">${esc(t("cuNewCodeGo"))}</button></div>`);
ACT.cuNewCodeGo = async () => {
  try {
    const r = await api("/me/backup-code", { method: "POST" });
    newSession(r);
    openSheet(t("codeTitle"), `${codeBlock(r.backup_code)}
      <div class="btns"><button class="btn primary" type="button" data-act="cuCodeDone" data-code-next disabled>${esc(t("done"))}</button></div>`);
  } catch (e) {
    toast(errText(e));
  }
};
ACT.cuCodeDone = () => {
  closeSheet();
  render();
};

// "Descargar mis datos": the CSV through fetch, so the lock proof goes along (a plain link cannot send it).
ACT.exportCsv = () => downloadCsv();
async function downloadCsv() {
  try {
    const res = await fetch("/api/export.csv", { credentials: "same-origin", headers: S.unlock ? { "X-FZ-Unlock": S.unlock } : {} });
    if (!res.ok) throw Object.assign(new Error("export"), { code: res.status === 423 ? "unlock" : "http_" + res.status });
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement("a");
    a.href = url;
    a.download = `finanzas-${S.boot.today}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (e) {
    toast(errText(e));
  }
}
// Ajustes' own export link: with the lock on it would get a 423, so it goes through fetch then.
document.addEventListener("click", (e) => {
  const a = e.target.closest && e.target.closest('a[href="/api/export.csv"]');
  if (!a || !S.unlock) return;
  e.preventDefault();
  downloadCsv();
});

// "Eliminar mi cuenta y mis datos": type the username to confirm. Refused for the owner (server too).
ACT.cuDeleteMe = () =>
  openSheet(t("cuDelete"), `<form data-submit="cuDeleteGo">
    <p>${esc(t("cuDeleteBody"))}</p>
    <label class="field"><span>${esc(t("cuTypeUser", { u: S.boot.user.username }))}</span>
      <input name="confirm" autocapitalize="none" autocorrect="off" spellcheck="false" required></label>
    <p class="err" id="delErr" hidden></p>
    <div class="btns"><button class="btn danger">${esc(t("cuDeleteGo"))}</button></div></form>`);
ACT.cuDeleteGo = async (form) => {
  try {
    await api("/me", { method: "DELETE", body: { confirm: form.confirm.value } });
    S.unlock = null;
    history.replaceState(null, "", "#/");
    location.reload();
  } catch (e) {
    formError(form, form.querySelector("#delErr"), e.code === "confirm" ? t("cuConfirmWrong") : errText(e));
  }
};

// ---------- Personas en la app (owner) ----------
VIEWS["/ajustes/personas"] = async () => {
  if (!S.boot.user.is_owner) {
    location.hash = "#/ajustes";
    return;
  }
  const m = await api("/members");
  const byId = new Map(m.people.map((p) => [p.id, p]));
  const people = m.people.map((p) => `<button class="row" type="button" data-act="psnOpen" data-id="${Number(p.id)}">${tile(p.is_owner ? "home" : "users-group", "gray")}
      <span class="grow"><span class="title">${esc(p.display_name)}${p.is_owner ? ` <span class="pchip">${esc(t("cuOwner"))}</span>` : ""}</span>
      <span class="sub">${esc(t("cuJoined", { x: day(p.joined) }))} · ${esc(t("cuSeen", { x: day(p.last_seen) }))}</span></span>
      ${p.is_owner ? "" : icon("chevron-right", "chev")}</button>`).join("");
  const invites = m.invites.map((i) => {
    const who = i.kind === "reset" ? t("cuResetFor", { name: (byId.get(i.target_id) || {}).display_name || "?" }) : t("cuInviteOpen");
    const sub = i.kind === "reset" && i.usable_at > Date.now() ? t("cuResetPending", { x: when(i.usable_at) })
      : i.kind === "reset" ? t("cuResetLive", { x: when(i.expires_at) }) : t("cuExpires", { x: when(i.expires_at) });
    return `<div class="row">${tile(i.kind === "reset" ? "face-id" : "user-plus", "gray")}<span class="grow"><span class="title">${esc(who)}</span>
      <span class="sub${i.kind === "reset" ? " wrap" : ""}">${esc(sub)}</span></span>
      <button class="btn small" type="button" data-act="psnCancel" data-id="${Number(i.id)}">${esc(t("cancel"))}</button></div>`;
  }).join("");
  const signupOpen = m.invites.filter((i) => i.kind === "signup").length;
  pageMembers = m;
  await paint(() => (app.innerHTML = `${backBtn(["/ajustes"])}<h1>${esc(t("cuPeople"))}</h1>
    <p class="lead">${esc(t("cuPeopleLead"))}</p>
    <div class="list grouped">${people}</div>
    <h2>${esc(t("cuInvitesH"))}</h2>
    ${invites ? `<div class="list grouped">${invites}</div>` : `<p class="note">${esc(t("cuNoInvites"))}</p>`}
    <div class="btns"><button class="btn primary" type="button" data-act="psnInvite" ${signupOpen >= m.max_invites ? "disabled" : ""}>${icon("user-plus")}${esc(t("cuInvite"))}</button></div>
    <p class="note">${esc(t("cuInviteNote", { n: m.max_invites }))}</p>`));
};
let pageMembers = null;

// A backup code or a one-use link (#codeText) shown in the sheet goes out of the page as soon as the sheet closes
// (Listo, the X, Escape or a swipe): a closed <dialog> keeps its content otherwise.
sheet.addEventListener("close", () => {
  if (sheet.querySelector("#codeText")) sheet.replaceChildren();
});

/** A one-use link, shown once in a sheet with Copy (Melvin sends it on WhatsApp himself). */
function linkSheet(title, body, url, expires) {
  openSheet(title, `<p>${esc(body)}</p>
    <p class="code link" id="codeText">${esc(url)}</p>
    <p class="note">${esc(t("cuExpires", { x: when(expires) }))}</p>
    <div class="btns"><button class="btn primary" type="button" data-act="copyCode">${esc(t("copy"))}</button>
      <button class="btn" type="button" data-act="psnDone">${esc(t("done"))}</button></div>`);
}
ACT.psnDone = () => {
  closeSheet();
  render();
};
ACT.psnInvite = async (btn) => {
  btn.disabled = true;
  try {
    const r = await api("/invites", { method: "POST" });
    linkSheet(t("cuInviteReady"), t("cuInviteReadyBody"), r.url, r.expires_at);
  } catch (e) {
    toast(e.code === "too_many_invites" ? t("cuTooMany") : errText(e));
    btn.disabled = false;
  }
};
ACT.psnCancel = async (el) => {
  try {
    await api(`/invites/${Number(el.dataset.id)}`, { method: "DELETE" });
    toast(t("cuCancelled"));
    await render();
  } catch (e) {
    toast(errText(e));
  }
};
ACT.psnOpen = (el) => {
  const p = pageMembers && pageMembers.people.find((x) => x.id === Number(el.dataset.id));
  if (!p || p.is_owner) return;
  openSheet(p.display_name, `<div class="kv"><span>${esc(t("username"))}</span><span>${esc(p.username)}</span></div>
    <div class="kv"><span>${esc(t("cuJoinedH"))}</span><span>${esc(when(p.joined))}</span></div>
    <div class="kv"><span>${esc(t("cuSeenH"))}</span><span>${esc(when(p.last_seen))}</span></div>
    <div class="kv"><span>Face ID</span><span class="num">${Number(p.passkeys)}</span></div>
    <div class="btns"><button class="btn" type="button" data-act="psnReset" data-id="${Number(p.id)}">${icon("face-id")}${esc(t("cuResetFid"))}</button></div>
    <p class="note">${esc(t("cuResetNote"))}</p>
    <form data-submit="psnRemove" data-id="${Number(p.id)}">
      <h2>${esc(t("cuRemove"))}</h2>
      <p class="note">${esc(t("cuRemoveBody", { name: p.display_name }))}</p>
      <label class="field"><span>${esc(t("cuTypeUser", { u: p.username }))}</span>
        <input name="confirm" autocapitalize="none" autocorrect="off" spellcheck="false" required></label>
      <p class="err" id="rmErr" hidden></p>
      <div class="btns"><button class="btn danger">${esc(t("cuRemoveGo"))}</button></div>
    </form>`);
};
ACT.psnReset = async (el) => {
  try {
    const r = await api(`/members/${Number(el.dataset.id)}/reset`, { method: "POST" });
    linkSheet(t("cuResetReady"), t("cuResetReadyBody", { x: whenDot(r.usable_at) }), r.url, r.expires_at);
  } catch (e) {
    toast(errText(e));
  }
};
ACT.psnRemove = async (form) => {
  try {
    await api(`/members/${Number(form.dataset.id)}`, { method: "DELETE", body: { confirm: form.confirm.value } });
    closeSheet();
    toast(t("cuRemoved"));
    await render();
  } catch (e) {
    formError(form, form.querySelector("#rmErr"), e.code === "confirm" ? t("cuConfirmWrong") : errText(e));
  }
};
