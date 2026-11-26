// "Primeros pasos": the setup card on Home and its step screens (Cuentas owns 1, 2, 3 and 8).
// Step ids and states are a contract with Importar and Funciones (src/lib/steps.ts). Importar's screens are
// #/importar (statements), #/pasos/ahorro (savings) and #/pasos/limites (limits); Funciones' is #/pasos/alertas.
// The server works out limits, statements and lock from her data; the rest are saved through hooks.step.
import { S, app, VIEWS, ACT, hooks } from "../state.js";
import { t } from "../i18n.js";
import { esc } from "../format.js";
import { api } from "../api.js";
import { cached } from "../data.js";
import { render } from "../router.js";
import { icon, tile, groupLook } from "../look.js";
import { toast, errText, backBtn, openSheet, closeSheet } from "../ui.js";
import { paint } from "../motion.js";
import { addPasskey, passkeyError, unlockWithPasskey } from "../passkey.js";
import { setLock } from "../lock.js";

/** Save one step's state through the API (api() empties the screens in memory). Used by Importar too. */
hooks.step = (id, state) => api(`/setup/steps/${encodeURIComponent(id)}`, { method: "PUT", body: { state } });

/**
 * Places other agents fill in. cardDates(account): Funciones' closing day and due day for one card, shown under
 * that card in "¿Con qué pagas?" (HTML, already escaped). Not built in this wave.
 */
export const slots = { cardDates: null };

/** The card's data, kept in memory like Home's (key "setup"). */
export const setupPart = () => ["setup", () => api("/setup")];

const STEP_HREF = {
  home_screen: "#/pasos/inicio", accounts: "#/pasos/cuentas", life: "#/pasos/vida", statements: "#/importar",
  savings: "#/pasos/ahorro", limits: "#/pasos/limites", alerts: "#/pasos/alertas", lock: "#/pasos/bloqueo", bac_email: "#/pasos/correos",
};
const STEP_ICON = {
  home_screen: "square-plus", accounts: "credit-card", life: "category", statements: "upload", savings: "building-bank",
  limits: "chart-bar", alerts: "inbox", lock: "lock", bac_email: "inbox",
};

const standalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

/** The steps that count: available now and for her. done + hidden of these is the "3 de 8". */
export function counted(setup) {
  return setup.steps.filter((s) => s.available && s.applies);
}
export function progress(setup) {
  const list = counted(setup);
  return { done: list.filter((s) => s.state === "done" || s.state === "hidden").length, total: list.length };
}

/** Running from the Home Screen: step 1 is done by itself (saved in the background). */
export function markStandalone(setup) {
  const hs = setup && setup.steps.find((s) => s.id === "home_screen");
  if (hs && hs.state === "open" && standalone()) {
    hs.state = "done";
    hooks.step("home_screen", "done").catch(() => {});
  }
}

/**
 * The card for Home, or "" when it is hidden or everything that applies is done. After Importar's
 * "Esperar un mes" and a month of data, the limits offer shows even when she hid the card (she asked for it).
 */
export function setupCard(setup) {
  if (!setup) return "";
  const { done, total } = progress(setup);
  if (setup.card === "hidden" || done >= total) {
    return setup.limits_ready
      ? `<a class="lrow ready-row" href="#/pasos/limites">${tile("chart-bar", "accent")}<span class="name">${esc(t("psLimitsReady"))}</span>${icon("chevron-right", "chev")}</a>`
      : "";
  }
  const rows = counted(setup)
    .filter((s) => s.state === "open" || s.state === "waiting")
    .map((s) => {
      const ready = s.id === "limits" && setup.limits_ready;
      const sub = ready ? t("psLimitsReady") : s.state === "waiting" ? t("psWaiting") : t("ps_" + s.id + "_sub");
      return `<a class="row" href="${STEP_HREF[s.id]}">${tile(STEP_ICON[s.id], ready ? "accent" : "gray")}
        <span class="grow"><span class="title">${esc(t("ps_" + s.id))}</span><span class="sub">${esc(sub)}</span></span>
        ${icon("chevron-right", "chev")}</a>`;
    })
    .join("");
  return `<section class="setup-card" aria-labelledby="psTitle">
    <div class="sec-head"><h2 id="psTitle">${esc(t("psTitle"))}</h2><span class="pchip num">${esc(t("psCount", { n: done, total }))}</span></div>
    <span class="track thin" aria-hidden="true"><i class="fill" data-w="${((done / total) * 100).toFixed(2)}"></i></span>
    <div class="list grouped">${rows}</div>
    <div class="btns"><button class="btn" type="button" data-act="psHide">${esc(t("psHide"))}</button></div>
  </section>`;
}

/** Home before her first movement: the card and two ways to start, never an empty page. */
export function startHtml(setup) {
  return `${setupCard(setup)}
    <section class="start" aria-label="${esc(t("psStart"))}">
      <h2>${esc(t("psStart"))}</h2>
      <p class="note">${esc(t("psStartBody"))}</p>
      <div class="btns"><a class="btn primary" href="#/agregar">${icon("plus")}${esc(t("addPurchase"))}</a>
        <a class="btn" href="#/importar">${icon("upload")}${esc(t("psUpload"))}</a></div>
    </section>`;
}

/** Load the card data for Home (memory first). Also marks step 1 when the app runs from the Home Screen. */
export async function loadSetup() {
  const { value, fresh } = cached(...setupPart());
  const setup = value !== undefined ? value : await fresh;
  markStandalone(setup);
  return setup;
}

ACT.psHide = async () => {
  try {
    await api("/setup/card", { method: "PUT", body: { hidden: true } });
    toast(t("psHidden"));
    render();
  } catch (e) {
    toast(errText(e));
  }
};

async function finishStep(id, state = "done", msg) {
  try {
    await hooks.step(id, state);
    if (msg) toast(msg);
    location.hash = "#/";
  } catch (e) {
    toast(errText(e));
  }
}
ACT.psSkip = (el) => finishStep(el.dataset.step, "hidden");
ACT.psDone = (el) => finishStep(el.dataset.step, "done", t("saved"));

const stepHead = (id) => `${backBtn(["/"])}<h1>${esc(t("ps_" + id))}</h1>`;
const skipBtn = (id) => `<button class="btn" type="button" data-act="psSkip" data-step="${esc(id)}">${esc(t("psNotNow"))}</button>`;

// ---------- 1. Agregar a inicio ----------
VIEWS["/pasos/inicio"] = async () => {
  if (standalone()) {
    await finishStep("home_screen", "done");
    return;
  }
  await paint(() => (app.innerHTML = `${stepHead("home_screen")}
    <p class="lead">${esc(t("psHomeLead"))}</p>
    <ol class="guide">
      <li>${icon("upload")}<span>${esc(t("psHome1"))}</span></li>
      <li>${icon("square-plus")}<span>${esc(t("psHome2"))}</span></li>
      <li>${icon("check")}<span>${esc(t("psHome3"))}</span></li>
    </ol>
    <p class="note">${esc(t("psHomeNote"))}</p>
    <div class="btns"><button class="btn primary" type="button" data-act="psDone" data-step="home_screen">${esc(t("psDidIt"))}</button>${skipBtn("home_screen")}</div>`));
};

// ---------- 2. ¿Con qué pagas? ----------
const PAY = [
  ["BAC tarjeta", "tarjeta"], ["BAC cuenta", "cuenta"], ["Agrícola tarjeta", "tarjeta"], ["Agrícola cuenta", "cuenta"],
  ["Efectivo", "efectivo"], ["UglyCash", "billetera"],
];
VIEWS["/pasos/cuentas"] = async () => {
  const have = new Set(S.boot.accounts.filter((a) => !a.archived).map((a) => a.name.toLowerCase()));
  const chips = PAY.map(([name, kind]) => {
    const on = have.has(name.toLowerCase());
    return `<button class="chip" type="button" data-act="psPay" data-name="${esc(name)}" data-kind="${kind}" aria-pressed="${on}" ${on ? "disabled" : ""}>${esc(name)}</button>`;
  }).join("");
  // Funciones fills each card's closing day and due day here (slots.cardDates).
  const cards = S.boot.accounts.filter((a) => !a.archived && a.kind === "tarjeta");
  const dates = slots.cardDates ? cards.map((a) => slots.cardDates(a)).join("") : "";
  await paint(() => (app.innerHTML = `${stepHead("accounts")}
    <p class="lead">${esc(t("psPayLead"))}</p>
    <div class="chips" id="payChips">${chips}<button class="chip" type="button" data-act="psPayOther" aria-pressed="false">${esc(t("psOther"))}</button></div>
    <form id="payOther" class="pay-other" data-submit="psPayAdd" hidden>
      <label class="field"><span>${esc(t("name"))}</span><input name="name" maxlength="40" required></label>
      <label class="field"><span>${esc(t("account_kind"))}</span><select name="kind">${["tarjeta", "cuenta", "efectivo", "billetera"].map((k) => `<option value="${k}">${esc(t("acc_" + k))}</option>`).join("")}</select></label>
      <button class="btn">${icon("plus")}${esc(t("addAccount"))}</button>
    </form>
    <div id="cardDates">${dates}</div>
    <p class="note">${esc(t("psPayNote"))}</p>
    <div class="btns"><button class="btn primary" type="button" data-act="psPaySave">${esc(t("save"))}</button>${skipBtn("accounts")}</div>`));
};
ACT.psPay = (el) => el.setAttribute("aria-pressed", String(el.getAttribute("aria-pressed") !== "true"));
ACT.psPayOther = (el) => {
  const f = document.getElementById("payOther");
  f.hidden = !f.hidden;
  el.setAttribute("aria-pressed", String(!f.hidden));
  if (!f.hidden) f.name.focus();
};
ACT.psPayAdd = (form) => {
  const name = form.name.value.trim();
  if (!name) return;
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "chip";
  chip.dataset.act = "psPay";
  chip.dataset.name = name;
  chip.dataset.kind = form.kind.value;
  chip.setAttribute("aria-pressed", "true");
  chip.textContent = name;
  document.getElementById("payChips").insertBefore(chip, document.querySelector('[data-act="psPayOther"]'));
  form.reset();
};
ACT.psPaySave = async (btn) => {
  const picked = [...document.querySelectorAll('#payChips [data-act="psPay"][aria-pressed="true"]:not([disabled])')];
  btn.disabled = true;
  try {
    for (const c of picked) {
      try {
        await api("/accounts", { method: "POST", body: { name: c.dataset.name, kind: c.dataset.kind } });
      } catch (e) {
        if (e.code !== "name_taken") throw e;
      }
    }
    S.boot = null; // the accounts changed
    await finishStep("accounts", "done", t("saved"));
  } catch (e) {
    toast(errText(e));
    btn.disabled = false;
  }
};

// ---------- 3. Tu vida ----------
const LIFE_Q = ["rent", "vehicle", "pet", "work", "family", "shared", "travel"];
// What each answer shows today, to start the switches where she is (yes = the starter rows are not archived).
const LIFE_NOW = {
  rent: ["c", "Alquiler o cuota"], vehicle: ["c", "Gasolina"], pet: ["c", "Mascotas"], work: ["g", "Trabajo"],
  family: ["g", "Familia"], shared: ["g", "Pareja y personas"], travel: ["g", "Viajes"],
};
VIEWS["/pasos/vida"] = async (params) => {
  if (params.get("lista") === "1") return lifeList();
  const setup = await loadSetup();
  const now = (q) => {
    if (q in setup.life) return setup.life[q];
    const [kind, name] = LIFE_NOW[q];
    const row = (kind === "g" ? S.boot.groups : S.boot.categories).find((x) => x.name === name);
    return row ? !row.archived : true;
  };
  await paint(() => (app.innerHTML = `${stepHead("life")}
    <p class="lead">${esc(t("psLifeLead"))}</p>
    <form data-submit="psLifeSave" class="life">
      ${LIFE_Q.map((q) => `<fieldset class="yn"><legend>${esc(t("lq_" + q))}</legend>
        <div class="seg"><label><input type="radio" name="${q}" value="1" ${now(q) ? "checked" : ""}><span>${esc(t("yes"))}</span></label>
        <label><input type="radio" name="${q}" value="0" ${now(q) ? "" : "checked"}><span>${esc(t("no"))}</span></label></div></fieldset>`).join("")}
      <div class="btns"><button class="btn primary">${esc(t("suNext"))}</button></div>
    </form>`));
};
ACT.psLifeSave = async (form) => {
  const answers = Object.fromEntries(LIFE_Q.map((q) => [q, form.elements[q].value === "1"]));
  try {
    await api("/setup/life", { method: "POST", body: { answers } });
    S.boot = null;
    location.hash = "#/pasos/vida?lista=1";
  } catch (e) {
    toast(errText(e));
  }
};

// The full list: a switch per group (shown or archived), rename, and "+ Crear grupo".
async function lifeList() {
  const groups = S.boot.groups;
  await paint(() => (app.innerHTML = `${stepHead("life")}
    <p class="lead">${esc(t("psListLead"))}</p>
    <div class="list grouped">${groups.map((g) => {
      const [ic, color] = groupLook(g.name);
      const cats = S.boot.categories.filter((c) => c.group_id === g.id && !c.archived).map((c) => c.name).join(", ");
      return `<div class="row">${tile(ic, color)}
        <button class="grow linkish" type="button" data-act="psRename" data-id="${g.id}"><span class="title">${esc(g.name)}</span><span class="sub">${esc(cats)}</span></button>
        <label class="switch"><input type="checkbox" data-group="${g.id}" ${g.archived ? "" : "checked"} aria-label="${esc(t("psShowGroup", { g: g.name }))}"><i aria-hidden="true"></i></label></div>`;
    }).join("")}</div>
    <div class="btns"><button class="btn" type="button" data-act="psNewGroup">${icon("plus")}${esc(t("psCreateGroup"))}</button></div>
    <div class="btns"><button class="btn primary" type="button" data-act="psDone" data-step="life">${esc(t("done"))}</button></div>`));
}
// A switch: show or archive the group (nothing is deleted).
document.addEventListener("change", async (e) => {
  const box = e.target;
  if (!box.matches || !box.matches("input[data-group]")) return;
  try {
    await api(`/groups/${Number(box.dataset.group)}`, { method: "PUT", body: { archived: !box.checked } });
    const g = S.boot && S.boot.groups.find((x) => x.id === Number(box.dataset.group));
    if (g) g.archived = box.checked ? 0 : 1; // the screen stays; the list in memory follows the switch
  } catch (err) {
    box.checked = !box.checked;
    toast(errText(err));
  }
});
ACT.psRename = (el) => {
  const g = S.boot.groups.find((x) => x.id === Number(el.dataset.id));
  if (!g) return;
  openSheet(t("psRename"), `<form data-submit="psRenameSave" data-id="${g.id}">
    <label class="field"><span>${esc(t("name"))}</span><input name="name" maxlength="40" required value="${esc(g.name)}"></label>
    <div class="btns"><button class="btn primary">${esc(t("save"))}</button></div></form>`);
};
ACT.psRenameSave = async (form) => {
  try {
    await api(`/groups/${Number(form.dataset.id)}`, { method: "PUT", body: { name: form.name.value.trim() } });
    closeSheet();
    S.boot = null;
    await render();
  } catch (e) {
    toast(errText(e));
  }
};
ACT.psNewGroup = () =>
  openSheet(t("psCreateGroup"), `<form data-submit="psNewGroupSave">
    <label class="field"><span>${esc(t("name"))}</span><input name="name" maxlength="40" required></label>
    <fieldset class="yn"><legend>${esc(t("kind"))}</legend><div class="seg">${["E", "G", "A"].map((k, i) =>
      `<label><input type="radio" name="kind" value="${k}" ${i === 0 ? "checked" : ""}><span>${esc(t("kind" + k))}</span></label>`).join("")}</div></fieldset>
    <div class="btns"><button class="btn primary">${esc(t("save"))}</button></div></form>`);
// A new group gets one category with the same name and the chosen kind, so it can be picked right away.
ACT.psNewGroupSave = async (form) => {
  const name = form.name.value.trim();
  try {
    const r = await api("/groups", { method: "POST", body: { name } });
    const groupId = (r.group && r.group.id) || r.id;
    await api("/categories", { method: "POST", body: { group_id: groupId, name, kind: form.elements.kind.value } });
    closeSheet();
    S.boot = null;
    await render();
  } catch (e) {
    toast(errText(e));
  }
};

// ---------- 8. Bloqueo con Face ID ----------
VIEWS["/pasos/bloqueo"] = async () => {
  const setup = await loadSetup();
  const on = setup.app_lock;
  await paint(() => (app.innerHTML = `${stepHead("lock")}
    <p class="lead">${esc(t("psLockLead"))}</p>
    <p class="note">${esc(t("psLockNote"))}</p>
    <p class="err" id="lockStepErr" hidden></p>
    ${on ? `<div class="kv"><span>${esc(t("psLockState"))}</span><span>${esc(t("psLockOn"))}</span></div>
      <div class="btns"><button class="btn" type="button" data-act="psLockOff">${esc(t("psLockOff"))}</button></div>`
      : `<div class="btns"><button class="btn primary" type="button" data-act="psLockOnBtn" data-has="${setup.has_passkey ? 1 : 0}">${esc(t(setup.has_passkey ? "psLockTurnOn" : "psLockAddFid"))}</button>${skipBtn("lock")}</div>`}`));
};
ACT.psLockOnBtn = async (btn) => {
  const err = document.getElementById("lockStepErr");
  btn.disabled = true;
  try {
    if (btn.dataset.has !== "1") S.unlock = (await addPasskey()) || S.unlock;
    const r = await unlockWithPasskey(true);
    setLock(r.app_lock, r.unlock);
    toast(t("psLockDone"));
    location.hash = "#/";
  } catch (e) {
    err.hidden = false;
    err.textContent = t(passkeyError(e));
    btn.disabled = false;
  }
};
ACT.psLockOff = async () => {
  try {
    await api("/me/lock", { method: "PUT", body: { on: false } });
    setLock(false, null);
    toast(t("psLockOffDone"));
    render();
  } catch (e) {
    toast(errText(e));
  }
};
