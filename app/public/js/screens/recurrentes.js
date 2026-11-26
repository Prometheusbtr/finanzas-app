// Funciones (Wave 2), Recurrentes (Más → Recurrentes): fixed payments she expects (rent, phone, a subscription).
// The app never creates a movement from them: it shows what is coming and counts this month's unpaid ones on Home.
import { S, app, VIEWS, ACT, PARTS } from "../state.js";
import { t } from "../i18n.js";
import { esc, money, parseCents, centsToInput, dateLabel } from "../format.js";
import { api } from "../api.js";
import { showCached, accountsWith, catsWith } from "../data.js";
import { toast, errText, openSheet, closeSheet } from "../ui.js";
import { tile, icon, catTile } from "../look.js";
import { paint } from "../motion.js";
import { render } from "../router.js";
import { fnBack } from "./personas.js";

export const EVERY = ["week", "2weeks", "month", "year"];
const recurringPart = () => ["recurring", () => api("/recurring")];
const fromDays = (d) => (d <= 9 ? "week" : d <= 18 ? "2weeks" : d <= 60 ? "month" : "year");

/** The next date on or after `today`, stepping from `fecha` by the cadence (the day of the month kept). */
function nextFrom(fecha, every, today) {
  let d = new Date(fecha + "T12:00:00Z");
  const day = d.getUTCDate();
  for (let i = 0; i < 600 && d.toISOString().slice(0, 10) < today; i++) {
    if (every === "week" || every === "2weeks") d = new Date(d.getTime() + (every === "week" ? 7 : 14) * 86_400_000);
    else {
      const m = d.getUTCMonth() + (every === "year" ? 12 : 1);
      const y = d.getUTCFullYear() + Math.floor(m / 12);
      const last = new Date(Date.UTC(y, (m % 12) + 1, 0)).getUTCDate();
      d = new Date(Date.UTC(y, m % 12, Math.min(day, last), 12));
    }
  }
  return d.toISOString().slice(0, 10);
}

let items = []; // the list on screen, for the edit sheet
let sugg = [];

PARTS["/mas/recurrentes"] = () => [recurringPart()];
VIEWS["/mas/recurrentes"] = async () => {
  await showCached([recurringPart()], async ([r]) => {
    items = r.items;
    sugg = r.suggestions;
    const rows = r.items.map((x) => {
      const when = x.next_date ? (x.late ? t("fnLate", { d: dateLabel(x.next_date) }) : t("fnNext", { d: dateLabel(x.next_date) })) : "";
      const sub = [t("fnEvery_" + x.every), when].filter(Boolean).join(" · ");
      return `<button class="row" type="button" data-act="fnRecEdit" data-id="${x.id}">${x.category_id ? catTile(x.category_id) : tile("repeat", "gray")}
        <span class="grow"><span class="title">${esc(x.name)}</span><span class="sub${x.late ? " warn" : ""}">${esc(sub)}</span></span>
        <span class="amt num">${esc(money(x.amount_cents))}</span></button>`;
    }).join("");
    const sug = r.suggestions.map((s, i) => `<div class="row">${tile("repeat", "gray")}
        <span class="grow"><span class="title">${esc(s.comercio || s.merchant_key)}</span>
        <span class="sub">${esc(t("fnEvery_" + fromDays(s.every_days)))} · ${esc(money(s.amount_cents))} · ${esc(t("fnSeenN", { n: s.count }))}</span></span>
        <span class="side fn-sug"><button class="btn small primary" type="button" data-act="fnSugKeep" data-i="${i}">${esc(t("fnKeep"))}</button>
        <button class="btn small" type="button" data-act="fnSugNo" data-i="${i}">${esc(t("fnNotFixed"))}</button></span></div>`).join("");
    await paint(() => (app.innerHTML = `${fnBack("/mas")}<h1>${esc(t("fnRecurring"))}</h1>
      <p class="lead">${esc(t("fnRecurringLead"))}</p>
      ${rows ? `<div class="list grouped">${rows}</div>` : `<p class="note">${esc(t("fnNoRecurring"))}</p>`}
      <div class="btns"><button class="btn primary" type="button" data-act="fnRecEdit" data-id="0">${icon("plus")}${esc(t("fnAddRecurring"))}</button></div>
      ${sug ? `<h2>${esc(t("fnSuggested"))}</h2><p class="note">${esc(t("fnSuggestedNote"))}</p><div class="list grouped">${sug}</div>` : ""}
      <p class="note">${esc(t("fnRecurringNote"))}</p>`));
  });
};

ACT.fnRecEdit = (el) => {
  const id = Number(el.dataset.id);
  const x = id ? items.find((i) => i.id === id) : null;
  if (id && !x) return;
  // F39: the rule's own account and category stay in the list even when archived, so an edit never clears them
  const accList = accountsWith(x ? x.account_id : null);
  const catList = catsWith(x ? x.category_id : null);
  const accs = `<option value="">${esc(t("none"))}</option>` + accList
    .map((a) => `<option value="${a.id}" ${x && x.account_id === a.id ? "selected" : ""}>${esc(a.name)}</option>`).join("");
  const cats = `<option value="">${esc(t("none"))}</option>` + catList
    .map((c) => `<option value="${c.id}" ${x && x.category_id === c.id ? "selected" : ""}>${esc(c.name)}</option>`).join("");
  openSheet(x ? x.name : t("fnAddRecurring"), `<form data-submit="fnRecSave" data-id="${id}">
    <label class="field"><span>${esc(t("name"))}</span><input name="name" maxlength="80" required value="${esc(x ? x.name : "")}" placeholder="${esc(t("fnRecPh"))}"></label>
    <div class="two"><label class="field"><span>${esc(t("amount"))}</span><input name="amount" inputmode="decimal" required value="${x ? centsToInput(x.amount_cents) : ""}"></label>
    <label class="field"><span>${esc(t("fnHowOften"))}</span><select name="every">${EVERY.map((e) => `<option value="${e}" ${(x ? x.every : "month") === e ? "selected" : ""}>${esc(t("fnEvery_" + e))}</option>`).join("")}</select></label></div>
    <label class="field"><span>${esc(t("fnNextDate"))}</span><input name="next" type="date" required value="${esc(x && x.next_date ? x.next_date : S.boot.today)}" data-shown="${esc(x && x.next_date ? x.next_date : "")}"></label>
    <div class="two"><label class="field"><span>${esc(t("account"))}</span><select name="account">${accs}</select></label>
    <label class="field"><span>${esc(t("category"))}</span><select name="category">${cats}</select></label></div>
    <p class="hint">${esc(t("fnRecHint"))}</p>
    <p class="err" id="fnErr" hidden></p>
    <div class="btns"><button class="btn primary">${esc(t("save"))}</button>
    ${x ? `<button type="button" class="btn danger" data-act="fnRecDel" data-id="${x.id}">${esc(t("delete"))}</button>` : ""}</div></form>`);
};
ACT.fnRecSave = async (form) => {
  const id = Number(form.dataset.id);
  const err = form.querySelector("#fnErr");
  const cents = parseCents(form.amount.value);
  if (!cents) {
    err.textContent = t("invalidAmount");
    err.hidden = false;
    return;
  }
  const body = {
    name: form.name.value.trim(), amount_cents: cents, every: EVERY.includes(form.every.value) ? form.every.value : "month",
    next_date: form.next.value, account_id: Number(form.account.value) || null, category_id: Number(form.category.value) || null,
  };
  // F16: the date shown is the next unpaid one, not the day the payment is kept on (a rule on the 31st shows the
  // 30th in November). Sent back unchanged it would move the rule for good, so an edit sends it only when changed.
  if (id && form.next.value === form.next.dataset.shown) delete body.next_date;
  try {
    await api(id ? `/recurring/${id}` : "/recurring", { method: id ? "PUT" : "POST", body });
    closeSheet();
    toast(t("saved"));
    render();
  } catch (e) {
    err.textContent = e.code === "too_many" ? t("fnTooMany") : errText(e);
    err.hidden = false;
  }
};
ACT.fnRecDel = async (el) => {
  if (!el.classList.contains("armed")) {
    el.classList.add("armed");
    el.textContent = t("confirmDelete");
    return;
  }
  try {
    await api(`/recurring/${Number(el.dataset.id)}`, { method: "DELETE" });
    closeSheet();
    toast(t("deleted"));
    render();
  } catch (e) {
    toast(errText(e));
  }
};

ACT.fnSugKeep = async (el) => {
  const s = sugg[Number(el.dataset.i)];
  if (!s) return;
  const every = fromDays(s.every_days);
  try {
    await api("/recurring", { method: "POST", body: {
      name: (s.comercio || s.merchant_key).slice(0, 80), amount_cents: s.amount_cents, every,
      next_date: nextFrom(s.next_fecha || s.last_fecha, every, S.boot.today), merchant_key: s.merchant_key,
    } });
    toast(t("saved"));
    render();
  } catch (e) {
    toast(e.code === "too_many" ? t("fnTooMany") : errText(e));
  }
};
ACT.fnSugNo = async (el) => {
  const s = sugg[Number(el.dataset.i)];
  if (!s) return;
  try {
    await api("/recurring/dismiss", { method: "POST", body: { merchant_key: s.merchant_key } });
    render();
  } catch (e) {
    toast(errText(e));
  }
};
