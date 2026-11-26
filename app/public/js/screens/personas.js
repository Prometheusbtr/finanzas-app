// Funciones (Wave 2), Personas (Más → Personas): who owes whom. Her own list of names (not app users). A split or a
// purchase for someone never changes her spending; "Saldar" is never spending or income. Names go through esc().
import { S, app, sheet, VIEWS, ACT, PARTS } from "../state.js";
import { t } from "../i18n.js";
import { esc, money, parseCents, centsToInput, dateLabel, randomId } from "../format.js";
import { api } from "../api.js";
import { showCached, activeAccounts, activeCats, catName } from "../data.js";
import { toast, errText, openSheet, closeSheet } from "../ui.js";
import { icon, tile } from "../look.js";
import { paint, navAs } from "../motion.js";
import { render } from "../router.js";

const peoplePart = () => ["people", () => api("/people")];
/** The person's id from the address bar: a whole number only, or nothing. */
const idFrom = (params) => {
  const n = Number(params.get("id"));
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};
const personPart = (id) => ["person:" + id, () => api(`/people/${id}`)];

/** "Te debe $20.00" / "Le debés $15.00" / "Están a mano". */
export function balanceText(cents) {
  if (cents > 0) return t("fnOwesYou", { x: money(cents) });
  if (cents < 0) return t("fnYouOwe", { x: money(-cents) });
  return t("fnEven");
}

/** "‹ Volver" for Funciones' nested screens (router.js ACT.back knows only Más, Ajustes and Home). */
export function fnBack(to) {
  const name = to === "/mas/personas" ? t("fnPeople") : to === "/ajustes" ? t("settings") : to === "/" ? t("home") : t("moreTab");
  return `<button class="back" data-act="fnBack" data-to="${esc(to)}" aria-label="${esc(t("backTo", { x: name }))}">${icon("chevron-left")}<span>${esc(t("back"))}</span></button>`;
}
const BACK_TO = ["/mas", "/mas/personas", "/ajustes", "/"];
ACT.fnBack = (el) => {
  const to = BACK_TO.includes(el.dataset.to) ? el.dataset.to : "/mas";
  const st = history.state && typeof history.state.fz === "number" ? history.state.fz : 0;
  if (S.from === to && st > 1) return history.back();
  navAs("pop");
  location.hash = "#" + to;
};

// ---------- the list ----------
PARTS["/mas/personas"] = () => [peoplePart()];
VIEWS["/mas/personas"] = async () => {
  await showCached([peoplePart()], async ([r]) => {
    const rows = r.people.filter((p) => !p.archived).map((p) => `<a class="row" data-pre href="#/mas/persona?id=${p.id}">${tile("users-group", "gray")}
        <span class="grow"><span class="title">${esc(p.name)}</span><span class="sub">${esc(balanceText(p.balance_cents))}</span></span>
        <span class="side">${icon("chevron-right", "chev")}</span></a>`).join("");
    await paint(() => (app.innerHTML = `${fnBack("/mas")}<h1>${esc(t("fnPeople"))}</h1>
      <p class="lead">${esc(t("fnPeopleLead"))}</p>
      ${rows ? `<div class="list grouped">${rows}</div>` : `<p class="note">${esc(t("fnNoPeople"))}</p>`}
      <div class="btns"><button class="btn primary" type="button" data-act="fnPersonNew">${icon("user-plus")}${esc(t("fnAddPerson"))}</button></div>`));
  });
};

ACT.fnPersonNew = () => {
  openSheet(t("fnAddPerson"), `<form data-submit="fnPersonSave">
    <label class="field"><span>${esc(t("name"))}</span><input name="name" maxlength="60" required autocomplete="off"></label>
    <p class="err" id="fnErr" hidden></p>
    <div class="btns"><button class="btn primary">${esc(t("save"))}</button></div></form>`);
  setTimeout(() => sheet.querySelector("input[name=name]")?.focus(), 50);
};
ACT.fnPersonSave = async (form) => {
  try {
    const r = await api("/people", { method: "POST", body: { name: form.name.value.trim() } });
    peopleOn = true;
    closeSheet();
    location.hash = `#/mas/persona?id=${Number(r.id)}`;
  } catch (e) {
    showErr(form, e);
  }
};

function showErr(root, e) {
  const err = root.querySelector("#fnErr");
  if (!err) return toast(errText(e));
  err.textContent = typeof e === "string" ? e : errText(e);
  err.hidden = false;
}

// ---------- one person ----------
const KIND_ICON = { paid_for: "arrow-down-left", shared: "users-group", they_paid: "receipt-refund", settle: "arrows-exchange" };
let current = null; // the person on screen (her own data, this page only)

PARTS["/mas/persona"] = (params) => (idFrom(params) ? [personPart(idFrom(params))] : []);
VIEWS["/mas/persona"] = async (params) => {
  const id = idFrom(params);
  if (!id) {
    location.hash = "#/mas/personas";
    return;
  }
  await showCached([personPart(id)], async ([r]) => {
    current = r.person;
    const p = r.person;
    const rows = r.entries.map((e) => {
      const what = e.movement_id ? e.comercio || t("fnPurchase") : t("fnK_" + e.kind, { name: p.name });
      const sub = [e.movement_id ? t("fnK_" + e.kind, { name: p.name }) : "", dateLabel(e.fecha), e.nota].filter(Boolean).join(" · ");
      return `<div class="row">${tile(KIND_ICON[e.kind] || "category", "gray")}
        <span class="grow"><span class="title">${esc(what)}</span><span class="sub">${esc(sub)}</span></span>
        <span class="side num">${esc(e.cents > 0 ? "+" + money(e.cents) : money(e.cents))}
        <button class="btn small" type="button" data-act="fnEntryDel" data-id="${e.id}" aria-label="${esc(t("fnDeleteEntry"))}">${icon("x")}</button></span></div>`;
    }).join("");
    await paint(() => (app.innerHTML = `${fnBack("/mas/personas")}<h1>${esc(p.name)}</h1>
      <section class="summary"><p class="eyebrow">${esc(p.balance_cents > 0 ? t("fnOwesYouH") : p.balance_cents < 0 ? t("fnYouOweH") : t("fnEven"))}</p>
        <p class="hero num">${esc(money(Math.abs(p.balance_cents)))}</p></section>
      <div class="chips fn-acts">
        <button class="chip" type="button" data-act="fnPickBuy" data-kind="paid_for">${esc(t("fnPaidFor", { name: p.name }))}</button>
        <button class="chip" type="button" data-act="fnPickBuy" data-kind="shared">${esc(t("fnSplit"))}</button>
        <button class="chip" type="button" data-act="fnTheyPaid">${esc(t("fnTheyPaid", { name: p.name }))}</button>
        <button class="chip" type="button" data-act="fnSettle" ${p.balance_cents ? "" : "disabled"}>${esc(t("fnSettle"))}</button>
      </div>
      <p class="note">${esc(t("fnSettleNote"))}</p>
      ${rows ? `<h2>${esc(t("fnHistory"))}</h2><div class="list">${rows}</div>` : ""}
      <div class="btns"><button class="btn" type="button" data-act="fnPersonRename">${esc(t("psRename"))}</button>
        <button class="btn" type="button" data-act="fnPersonArchive">${esc(t("archive"))}</button></div>`));
  });
};

/** Purchases from the last weeks to pick from (newest first). */
async function recentBuys() {
  const r = await api("/movements?tipo=gasto&limit=60");
  return r.items;
}

ACT.fnPickBuy = async (el) => {
  const kind = el.dataset.kind === "paid_for" ? "paid_for" : "shared";
  let items;
  try {
    items = await recentBuys();
  } catch (e) {
    return toast(errText(e));
  }
  const rows = items.map((m) => `<button class="row" type="button" data-act="fnBuyChosen" data-kind="${kind}" data-id="${m.id}" data-cents="${m.amount_cents}">
      <span class="grow"><span class="title">${esc(m.comercio || catName(m.category_id))}</span><span class="sub">${esc(dateLabel(m.fecha))} · ${esc(catName(m.category_id))}</span></span>
      <span class="amt num">${esc(money(m.amount_cents))}</span></button>`).join("");
  openSheet(t("fnPickPurchase"), rows ? `<div class="list">${rows}</div>` : `<p class="note">${esc(t("fnNoPurchases"))}</p>`);
};
ACT.fnBuyChosen = (el) => shareForm(Number(el.dataset.id), Number(el.dataset.cents), el.dataset.kind, current ? [current] : []);

/** The share form for one purchase: whose part, how much (half or all to start). */
function shareForm(movementId, total, kind, people) {
  const start = kind === "paid_for" ? total : Math.round(total / 2);
  const pick = people.length === 1
    ? `<input type="hidden" name="person" value="${people[0].id}">`
    : `<label class="field"><span>${esc(t("fnWho"))}</span><select name="person">${people.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("")}</select></label>`;
  openSheet(t(kind === "paid_for" ? "fnPaidForH" : "fnSplit"), `<form data-submit="fnShareSave" data-mov="${movementId}">
    ${pick}
    <fieldset class="yn"><legend>${esc(t("fnHow"))}</legend><div class="seg">
      <label><input type="radio" name="kind" value="shared" ${kind === "shared" ? "checked" : ""}><span>${esc(t("fnSplitShort"))}</span></label>
      <label><input type="radio" name="kind" value="paid_for" ${kind === "paid_for" ? "checked" : ""}><span>${esc(t("fnAllTheirs"))}</span></label></div></fieldset>
    <label class="field"><span>${esc(t("fnTheirPart", { x: money(total) }))}</span><input name="cents" inputmode="decimal" value="${centsToInput(start)}"></label>
    <p class="err" id="fnErr" hidden></p>
    <div class="btns"><button class="btn primary">${esc(t("save"))}</button></div></form>`);
}
ACT.fnShareSave = async (form) => {
  const cents = parseCents(form.cents.value);
  if (!cents) return showErr(form, t("invalidAmount"));
  try {
    await api(`/people/${Number(form.person.value)}/share`, { method: "POST", body: { movement_id: Number(form.dataset.mov), kind: form.kind.value, cents } });
    closeSheet();
    toast(t("saved"));
    render();
  } catch (e) {
    showErr(form, e.code === "invalid:cents" ? t("fnTooMuch") : e);
  }
};

ACT.fnTheyPaid = () => {
  if (!current) return;
  const cats = activeCats().map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("");
  openSheet(t("fnTheyPaid", { name: current.name }), `<form data-submit="fnTheyPaidSave" data-cid="${randomId()}">
    <label class="field"><span>${esc(t("fnTheyPaidAmount"))}</span><input name="cents" inputmode="decimal" required></label>
    <label class="field"><span>${esc(t("where"))}</span><input name="comercio" maxlength="200"></label>
    <div class="two"><label class="field"><span>${esc(t("category"))}</span><select name="category"><option value="">${esc(t("none"))}</option>${cats}</select></label>
    <label class="field"><span>${esc(t("date"))}</span><input name="fecha" type="date" value="${esc(S.boot.today)}" max="${esc(S.boot.today)}"></label></div>
    <p class="note">${esc(t("fnTheyPaidNote"))}</p>
    <p class="err" id="fnErr" hidden></p>
    <div class="btns"><button class="btn primary">${esc(t("save"))}</button></div></form>`);
};
ACT.fnTheyPaidSave = async (form) => {
  const cents = parseCents(form.cents.value);
  if (!cents) return showErr(form, t("invalidAmount"));
  try {
    await api(`/people/${Number(current.id)}/they-paid`, { method: "POST", body: {
      client_id: form.dataset.cid, amount_cents: cents, comercio: form.comercio.value.trim(), category_id: Number(form.category.value) || null,
      fecha: form.fecha.value || S.boot.today,
    } });
    S.boot = null; // Home's counts changed (a new purchase)
    closeSheet();
    toast(t("saved"));
    render();
  } catch (e) {
    showErr(form, e);
  }
};

ACT.fnSettle = () => {
  if (!current) return;
  const owes = current.balance_cents;
  const accs = activeAccounts().map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join("");
  openSheet(t("fnSettle"), `<form data-submit="fnSettleSave" data-cid="${randomId()}">
    <fieldset class="yn"><legend>${esc(t("fnWhichWay"))}</legend><div class="seg">
      <label><input type="radio" name="dir" value="in" ${owes >= 0 ? "checked" : ""}><span>${esc(t("fnSettleIn", { name: current.name }))}</span></label>
      <label><input type="radio" name="dir" value="out" ${owes < 0 ? "checked" : ""}><span>${esc(t("fnSettleOut", { name: current.name }))}</span></label></div></fieldset>
    <label class="field"><span>${esc(t("amount"))}</span><input name="cents" inputmode="decimal" value="${centsToInput(Math.abs(owes))}"></label>
    <label class="field"><span>${esc(t("fnSettleAccount"))}</span><select name="account"><option value="">${esc(t("fnNoAccount"))}</option>${accs}</select></label>
    <p class="note">${esc(t("fnSettleNote"))}</p>
    <p class="err" id="fnErr" hidden></p>
    <div class="btns"><button class="btn primary">${esc(t("fnSettle"))}</button></div></form>`);
};
ACT.fnSettleSave = async (form) => {
  const cents = parseCents(form.cents.value);
  if (!cents) return showErr(form, t("invalidAmount"));
  try {
    await api(`/people/${Number(current.id)}/settle`, { method: "POST", body: {
      client_id: form.dataset.cid, amount_cents: cents, direction: form.dir.value === "out" ? "out" : "in", account_id: Number(form.account.value) || null,
    } });
    closeSheet();
    toast(t("fnSettled"));
    render();
  } catch (e) {
    showErr(form, e);
  }
};

ACT.fnEntryDel = async (el) => {
  if (!current) return;
  if (!el.classList.contains("armed")) {
    el.classList.add("armed", "danger");
    el.textContent = t("fnDeleteEntry");
    return;
  }
  try {
    await api(`/people/${Number(current.id)}/entries/${Number(el.dataset.id)}`, { method: "DELETE", body: {} });
    S.boot = null;
    toast(t("fnEntryRemoved"));
    render();
  } catch (e) {
    toast(errText(e));
  }
};

ACT.fnPersonRename = () => {
  if (!current) return;
  openSheet(t("psRename"), `<form data-submit="fnPersonRenameSave">
    <label class="field"><span>${esc(t("name"))}</span><input name="name" maxlength="60" required value="${esc(current.name)}"></label>
    <p class="err" id="fnErr" hidden></p>
    <div class="btns"><button class="btn primary">${esc(t("save"))}</button></div></form>`);
};
ACT.fnPersonRenameSave = async (form) => {
  try {
    await api(`/people/${Number(current.id)}`, { method: "PUT", body: { name: form.name.value.trim() } });
    closeSheet();
    render();
  } catch (e) {
    showErr(form, e);
  }
};
ACT.fnPersonArchive = async () => {
  if (!current) return;
  try {
    await api(`/people/${Number(current.id)}`, { method: "PUT", body: { archived: true } });
    toast(t("fnArchived"));
    location.hash = "#/mas/personas";
  } catch (e) {
    toast(errText(e));
  }
};

// ---------- from a purchase's edit sheet ----------
// On when her "Tu vida" answers say she shares costs, or once she has a person (Home's extras tell; until then on).
let peopleOn = null;
export const setPeopleOn = (v) => (peopleOn = !!v);
/** "Compartir con una persona" under a purchase (js/screens/movements.js edit sheet). */
export function shareRow(m) {
  if (m.tipo !== "gasto" || peopleOn === false) return "";
  return `<div class="btns"><button class="btn" type="button" data-act="fnShareMov" data-id="${m.id}" data-cents="${m.amount_cents}">${icon("users-group")}${esc(t("fnShareWith"))}</button></div>`;
}
ACT.fnShareMov = async (el) => {
  let r;
  try {
    r = await api("/people");
  } catch (e) {
    return toast(errText(e));
  }
  const people = r.people.filter((p) => !p.archived);
  if (!people.length) {
    closeSheet();
    navAs("push");
    location.hash = "#/mas/personas";
    return toast(t("fnAddFirst"));
  }
  shareForm(Number(el.dataset.id), Number(el.dataset.cents), "shared", people);
};
