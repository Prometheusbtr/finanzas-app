// Settings: language, theme, groups, categories, limits, accounts, export, sign out.
import { S, app, VIEWS, ACT, hooks } from "../state.js";
import { t } from "../i18n.js";
import { esc, money, moneyWhole, capFirst, centsToInput, dateLabel, dollarsToCents } from "../format.js";
import { api } from "../api.js";
import { catById, groupById, accById } from "../data.js";
import { toast, errText, openSheet, closeSheet, backBtn } from "../ui.js";
import { paint } from "../motion.js";
import { icon, groupTile, accountTile } from "../look.js";
import { render } from "../router.js";
import { accountRows } from "./cuenta.js";
import { alertsRow } from "./alertas.js"; // Funciones

function currentTheme() {
  try {
    return localStorage.getItem("fz_theme") || "system";
  } catch {
    return "system";
  }
}
VIEWS["/ajustes"] = async () => {
  const b = S.boot;
  const theme = currentTheme();
  const seg = (act, cur, opts) =>
    `<div class="seg">${opts.map(([v, label]) => `<button data-act="${act}" data-v="${v}" aria-pressed="${v === cur}">${esc(label)}</button>`).join("")}</div>`;
  const groups = b.groups
    .map((g) => {
      const cats = b.categories.filter((c) => c.group_id === g.id);
      return `<button class="row" data-act="editGroup" data-id="${g.id}">${groupTile(g)}<div class="grow">
        <div class="title">${esc(g.name)}${g.archived ? ` <span class="muted small">(${esc(t("archived"))})</span>` : ""}</div>
        <div class="sub">${esc(cats.filter((c) => !c.archived).map((c) => c.name).join(", "))}</div></div>
        <span class="amt">${g.limit_cents != null ? money(g.limit_cents) : `<span class="muted small">${esc(t("noLimit"))}</span>`}</span></button>`;
    })
    .join("");
  const accounts = b.accounts
    .map((a) => `<button class="row" data-act="editAcc" data-id="${a.id}">${accountTile(a)}<div class="grow"><div class="title">${esc(a.name)}</div>
      <div class="sub">${esc(t("acc_" + a.kind))}${a.archived ? " · " + esc(t("archived")) : ""}</div></div></button>`)
    .join("");
  await paint(() => (app.innerHTML = `${backBtn()}<h1>${esc(t("settings"))}</h1>
    <p class="lead">${esc(t("hello", { name: b.user.display_name }))}</p>
    <h2>${esc(t("language"))}</h2>${seg("setLang", S.lang, [["es", "Español"], ["en", "English"]])}
    <h2>${esc(t("theme"))}</h2>${seg("setTheme", theme, [["system", t("themeSystem")], ["light", t("themeLight")], ["dark", t("themeDark")]])}
    ${budgetRow(b.budget)}
    <h2>${esc(t("limits"))}</h2><div class="list grouped">${groups}</div>
    <div class="btns"><button class="btn" data-act="newGroup">${icon("plus")}${esc(t("addGroup"))}</button></div>
    <h2>${esc(t("accounts"))}</h2><div class="list grouped">${accounts}</div>
    <div class="btns"><button class="btn" data-act="newAcc">${icon("plus")}${esc(t("addAccount"))}</button></div>
    ${accountRows()}${alertsRow()}
    <h2>${esc(t("data"))}</h2>
    <div class="btns"><a class="btn" href="#/importar">${esc(t("impTitle"))}</a></div>
    <div class="btns"><a class="btn" href="/api/export.csv" download>${esc(t("export"))}</a></div>
    <h2>${esc(t("status"))}</h2>
    <div class="kv"><span>${esc(t("lastBac"))}</span><span class="num">${b.last_bac ? esc(dateLabel(b.last_bac.fecha) + (b.last_bac.hora ? " " + b.last_bac.hora : "")) : "—"}</span></div>
    <p class="note">${esc(t("bacNote"))}</p>
    <div class="btns"><button class="btn danger" data-act="logout">${esc(t("signOut"))}</button></div>`));
};
// ---------- Tu presupuesto: "Te quedan" per month (default) or per week (Feature 3) ----------
const DEFAULT_BUDGET = { period: "month", week_cents: null, week_start: 1 };
/** Weekday i (0 = Sunday) by name: Nov 22 2026 is a Sunday. */
const wdName = (i) => dateLabel(`2026-11-${22 + i}`, { weekday: "long" });
function budgetRow(bp) {
  const p = bp || DEFAULT_BUDGET;
  const sub = p.period !== "week" ? t("budgetSubMonth")
    : p.week_cents != null ? t("budgetSubWeekX", { x: money(p.week_cents), d: wdName(p.week_start) }) : t("budgetSubWeek", { d: wdName(p.week_start) });
  return `<h2>${esc(t("budgetH"))}</h2><div class="list grouped"><button class="row" data-act="budgetOpen"><span class="grow">
    <span class="title">${esc(t("budgetCount"))}</span><span class="sub">${esc(sub)}</span></span><span class="side">${icon("chevron-right", "chev")}</span></button></div>`;
}
ACT.budgetOpen = async () => {
  let r;
  try {
    r = await api("/me/budget");
  } catch (e) {
    toast(errText(e));
    return;
  }
  const week = r.period === "week";
  const days = [1, 2, 3, 4, 5, 6, 0].map((i) => `<option value="${i}" ${i === r.week_start ? "selected" : ""}>${esc(capFirst(wdName(i)))}</option>`).join("");
  const hint = r.derived_week_cents != null ? t("budgetDerived", { x: moneyWhole(r.derived_week_cents) }) : t("budgetNoLimits");
  openSheet(t("budgetCount"), `<form data-submit="budgetSave" data-period="${week ? "week" : "month"}">
    <div class="seg">${[["month", t("budgetMonth")], ["week", t("budgetWeek")]].map(([v, l]) =>
      `<button type="button" data-act="budgetPeriod" data-v="${v}" aria-pressed="${(v === "week") === week}">${esc(l)}</button>`).join("")}</div>
    <div class="budget-week" ${week ? "" : "hidden"}>
      <label class="field"><span>${esc(t("budgetAmt"))}</span><input name="amt" inputmode="decimal" value="${centsToInput(r.week_cents)}"
        placeholder="${r.derived_week_cents != null ? esc(String(Math.round(r.derived_week_cents / 100))) : ""}"></label>
      <p class="hint">${esc(hint)}</p>
      <label class="field"><span>${esc(t("budgetStart"))}</span><select name="start">${days}</select></label>
      <p class="hint">${esc(t("budgetNoteWeek"))}</p>
    </div>
    <p class="hint budget-month" ${week ? "hidden" : ""}>${esc(t("budgetNoteMonth"))}</p>
    <p class="err" hidden></p>
    <div class="btns"><button class="btn primary">${esc(t("save"))}</button></div></form>`);
};
ACT.budgetPeriod = (el) => {
  const form = el.closest("form");
  const week = el.dataset.v === "week";
  form.dataset.period = week ? "week" : "month";
  form.querySelectorAll('[data-act="budgetPeriod"]').forEach((b) => b.setAttribute("aria-pressed", String(b === el)));
  form.querySelector(".budget-week").hidden = !week;
  form.querySelector(".budget-month").hidden = week;
};
ACT.budgetSave = async (form) => {
  const err = form.querySelector(".err");
  const raw = form.amt.value.trim();
  const cents = raw ? dollarsToCents(raw) : null;
  if (raw && cents === null) {
    err.textContent = t("invalidAmount");
    err.hidden = false;
    return;
  }
  if (form.dataset.busy) return;
  form.dataset.busy = "1";
  try {
    const r = await api("/me/budget", { method: "PUT", body: { period: form.dataset.period === "week" ? "week" : "month", week_cents: cents, week_start: Number(form.start.value) } });
    S.boot.budget = r.budget;
    closeSheet();
    toast(t("saved"));
    render();
  } catch (e) {
    err.textContent = errText(e);
    err.hidden = false;
  } finally {
    delete form.dataset.busy;
  }
};
ACT.setLang = async (el) => {
  try {
    await api("/me", { method: "PUT", body: { lang: el.dataset.v } });
    S.boot = null;
    render();
  } catch (e) {
    toast(errText(e));
  }
};
ACT.setTheme = (el) => {
  const v = el.dataset.v;
  try {
    if (v === "system") localStorage.removeItem("fz_theme");
    else localStorage.setItem("fz_theme", v);
  } catch {}
  if (v === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", v);
  document.querySelectorAll('[data-act="setTheme"]').forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.v === v)));
};
ACT.logout = async () => {
  try {
    await api("/logout", { method: "POST" });
  } catch {}
  await hooks.dropPush?.(); // Seguridad W3: the next person here never gets her alerts
  // A full reload drops everything the page still holds in memory (movements, totals, names).
  S.boot = null;
  location.reload();
};

const kindOpts = (cur) => ["E", "G", "A", "M"].map((k) => `<option value="${k}" ${k === cur ? "selected" : ""}>${esc(t("kind" + k))}</option>`).join("");

ACT.editGroup = (el) => {
  const g = groupById(Number(el.dataset.id));
  const cats = S.boot.categories.filter((c) => c.group_id === g.id);
  openSheet(g.name, `<form data-submit="saveGroup" data-id="${g.id}">
      <label class="field"><span>${esc(t("name"))}</span><input name="name" maxlength="60" value="${esc(g.name)}" required></label>
      <label class="field"><span>${esc(t("limitMonthly"))}</span><input name="limit" inputmode="decimal" value="${centsToInput(g.limit_cents)}" placeholder="${esc(t("limitHint"))}"></label>
      <p class="err" id="gErr" hidden></p>
      <div class="btns"><button class="btn primary">${esc(t("save"))}</button>
      <button type="button" class="btn" data-act="archGroup" data-id="${g.id}" data-v="${g.archived ? 0 : 1}">${esc(g.archived ? t("unarchive") : t("archive"))}</button></div>
    </form>
    <h2>${esc(t("category"))}</h2>
    <div class="list grouped plain">${cats.map((c) => `<button class="row" data-act="editCat" data-id="${c.id}"><span class="grow"><span class="title">${esc(c.name)}</span>
      <span class="sub"><i class="dot k-${c.kind}"></i>${esc(t("kind" + c.kind))}${c.limit_cents != null ? " · " + money(c.limit_cents) : ""}${c.archived ? " · " + esc(t("archived")) : ""}</span></span></button>`).join("")}</div>
    <div class="btns"><button class="btn" data-act="newCat" data-group="${g.id}">${icon("plus")}${esc(t("addCategory"))}</button></div>`);
};
async function afterSetupChange() {
  S.boot = null;
  closeSheet();
  await render();
}
ACT.saveGroup = async (form) => {
  const lim = dollarsToCents(form.limit.value);
  const err = form.querySelector(".err");
  if (form.limit.value.trim() && lim === null) {
    err.textContent = t("invalidAmount");
    err.hidden = false;
    return;
  }
  try {
    await api(`/groups/${form.dataset.id}`, { method: "PUT", body: { name: form.name.value.trim(), limit_cents: lim } });
    await afterSetupChange();
    toast(t("saved"));
  } catch (e) {
    err.textContent = errText(e);
    err.hidden = false;
  }
};
ACT.archGroup = async (el) => {
  try {
    await api(`/groups/${el.dataset.id}`, { method: "PUT", body: { archived: el.dataset.v === "1" } });
    await afterSetupChange();
  } catch (e) {
    toast(errText(e));
  }
};
ACT.newGroup = () => {
  openSheet(t("newGroup"), `<form data-submit="createGroup">
    <label class="field"><span>${esc(t("name"))}</span><input name="name" maxlength="60" required></label>
    <label class="field"><span>${esc(t("limitMonthly"))}</span><input name="limit" inputmode="decimal" placeholder="${esc(t("limitHint"))}"></label>
    <p class="err" hidden></p><div class="btns"><button class="btn primary">${esc(t("save"))}</button></div></form>`);
};
ACT.createGroup = async (form) => {
  const err = form.querySelector(".err");
  try {
    await api("/groups", { method: "POST", body: { name: form.name.value.trim(), limit_cents: dollarsToCents(form.limit.value) } });
    await afterSetupChange();
  } catch (e) {
    err.textContent = errText(e);
    err.hidden = false;
  }
};
function catForm(c, groupId) {
  const groups = S.boot.groups.map((g) => `<option value="${g.id}" ${g.id === (c ? c.group_id : groupId) ? "selected" : ""}>${esc(g.name)}</option>`).join("");
  return `<form data-submit="${c ? "saveCat" : "createCat"}" data-id="${c ? c.id : ""}">
    <label class="field"><span>${esc(t("name"))}</span><input name="name" maxlength="60" value="${esc(c ? c.name : "")}" required></label>
    <div class="two"><label class="field"><span>${esc(t("kind"))}</span><select name="kind">${kindOpts(c ? c.kind : "G")}</select></label>
    <label class="field"><span>${esc(t("group"))}</span><select name="group">${groups}</select></label></div>
    <label class="field"><span>${esc(t("limitMonthly"))}</span><input name="limit" inputmode="decimal" value="${centsToInput(c ? c.limit_cents : null)}" placeholder="${esc(t("limitHint"))}"></label>
    <p class="err" hidden></p>
    <div class="btns"><button class="btn primary">${esc(t("save"))}</button>
    ${c ? `<button type="button" class="btn" data-act="archCat" data-id="${c.id}" data-v="${c.archived ? 0 : 1}">${esc(c.archived ? t("unarchive") : t("archive"))}</button>` : ""}</div></form>`;
}
ACT.editCat = (el) => {
  const c = catById(Number(el.dataset.id));
  openSheet(c.name, catForm(c));
};
ACT.newCat = (el) => openSheet(t("newCategory"), catForm(null, Number(el.dataset.group)));
async function submitCat(form, method, path) {
  const err = form.querySelector(".err");
  const lim = dollarsToCents(form.limit.value);
  if (form.limit.value.trim() && lim === null) {
    err.textContent = t("invalidAmount");
    err.hidden = false;
    return;
  }
  try {
    await api(path, { method, body: { name: form.name.value.trim(), kind: form.kind.value, group_id: Number(form.group.value), limit_cents: lim } });
    await afterSetupChange();
    toast(t("saved"));
  } catch (e) {
    err.textContent = errText(e);
    err.hidden = false;
  }
}
ACT.saveCat = (form) => submitCat(form, "PUT", `/categories/${form.dataset.id}`);
ACT.createCat = (form) => submitCat(form, "POST", "/categories");
ACT.archCat = async (el) => {
  try {
    await api(`/categories/${el.dataset.id}`, { method: "PUT", body: { archived: el.dataset.v === "1" } });
    await afterSetupChange();
  } catch (e) {
    toast(errText(e));
  }
};
function accForm(a) {
  const kinds = ["tarjeta", "cuenta", "efectivo", "billetera"];
  return `<form data-submit="${a ? "saveAcc" : "createAcc"}" data-id="${a ? a.id : ""}">
    <label class="field"><span>${esc(t("name"))}</span><input name="name" maxlength="60" value="${esc(a ? a.name : "")}" required></label>
    <label class="field"><span>${esc(t("account_kind"))}</span><select name="kind">${kinds.map((k) => `<option value="${k}" ${a && a.kind === k ? "selected" : ""}>${esc(t("acc_" + k))}</option>`).join("")}</select></label>
    <p class="err" hidden></p>
    <div class="btns"><button class="btn primary">${esc(t("save"))}</button>
    ${a ? `<button type="button" class="btn" data-act="archAcc" data-id="${a.id}" data-v="${a.archived ? 0 : 1}">${esc(a.archived ? t("unarchive") : t("archive"))}</button>` : ""}</div></form>`;
}
ACT.editAcc = (el) => {
  const a = accById(Number(el.dataset.id));
  openSheet(a.name, accForm(a));
};
ACT.newAcc = () => openSheet(t("newAccount"), accForm(null));
async function submitAcc(form, method, path) {
  const err = form.querySelector(".err");
  try {
    await api(path, { method, body: { name: form.name.value.trim(), kind: form.kind.value } });
    await afterSetupChange();
    toast(t("saved"));
  } catch (e) {
    err.textContent = errText(e);
    err.hidden = false;
  }
}
ACT.saveAcc = (form) => submitAcc(form, "PUT", `/accounts/${form.dataset.id}`);
ACT.createAcc = (form) => submitAcc(form, "POST", "/accounts");
ACT.archAcc = async (el) => {
  try {
    await api(`/accounts/${el.dataset.id}`, { method: "PUT", body: { archived: el.dataset.v === "1" } });
    await afterSetupChange();
  } catch (e) {
    toast(errText(e));
  }
};
