// Funciones (Wave 2), Tarjetas (Más → Tarjetas): closing day, due day and credit limit per card, the next due date
// and what the card holds since it last closed. Only the account's name is shown, never a card number.
// Also fills step 2's slot (pasos.js slots.cardDates) with the same two days for each card.
import { app, VIEWS, ACT, PARTS } from "../state.js";
import { t } from "../i18n.js";
import { esc, money, parseCents, centsToInput, dateLabel, applyBars } from "../format.js";
import { api } from "../api.js";
import { showCached } from "../data.js";
import { toast, errText, openSheet, closeSheet } from "../ui.js";
import { tile, icon } from "../look.js";
import { paint, slidePanel } from "../motion.js";
import { render } from "../router.js";
import { slots } from "./pasos.js";
import { fnBack } from "./personas.js";

const cardsPart = () => ["cards", () => api("/cards")];
const daysTo = (from, to) => Math.round((Date.parse(to + "T12:00:00Z") - Date.parse(from + "T12:00:00Z")) / 86_400_000);

/** "Vence en 3 días" / "Vence mañana" / "Vence hoy". */
export function dueText(today, due) {
  const n = daysTo(today, due);
  if (n <= 0) return t("fnDueToday");
  if (n === 1) return t("fnDueTomorrow");
  return t("fnDueIn", { n, d: dateLabel(due) });
}

PARTS["/mas/tarjetas"] = () => [cardsPart()];
VIEWS["/mas/tarjetas"] = async () => {
  await showCached([cardsPart()], async ([r]) => {
    const rows = r.cards.map((k) => {
      const days = k.closing_day && k.due_day ? t("fnCardDays", { c: k.closing_day, d: k.due_day }) : t("fnCardNoDays");
      const due = k.next_due ? dueText(r.today, k.next_due) : "";
      const used = k.limit_cents && k.cycle_spent_cents != null
        ? `<span class="track thin fn-track" aria-hidden="true"><i class="fill${k.cycle_spent_cents > k.limit_cents ? " bad" : ""}" data-w="${((Math.max(0, k.cycle_spent_cents) / k.limit_cents) * 100).toFixed(2)}"></i></span>
           <span class="sub">${esc(t("usedOf", { x: money(Math.max(0, k.cycle_spent_cents)), limit: money(k.limit_cents) }))}</span>`
        : k.cycle_spent_cents != null ? `<span class="sub">${esc(t("fnCycleSpent", { x: money(Math.max(0, k.cycle_spent_cents)) }))}</span>` : "";
      return `<button class="row" type="button" data-act="fnCardEdit" data-id="${k.account_id}">${tile("credit-card", "gray")}
        <span class="grow"><span class="title">${esc(k.name)}</span><span class="sub">${esc(days)}${due ? " · " + esc(due) : ""}</span>${used}</span>
        <span class="side">${icon("chevron-right", "chev")}</span></button>`;
    }).join("");
    await paint(() => {
      app.innerHTML = `${fnBack("/mas")}<h1>${esc(t("fnCards"))}</h1>
        <p class="lead">${esc(t("fnCardsLead"))}</p>
        ${rows ? `<div class="list grouped">${rows}</div>` : `<p class="note">${esc(t("fnNoCards"))}</p>`}
        <p class="note">${esc(t("fnCardsNote"))}</p>`;
      applyBars(app);
    });
  });
};

let cardsNow = []; // the list on screen, for the sheet
ACT.fnCardEdit = async (el) => {
  const id = Number(el.dataset.id);
  try {
    cardsNow = (await api("/cards")).cards;
  } catch (e) {
    return toast(errText(e));
  }
  const k = cardsNow.find((x) => x.account_id === id);
  if (!k) return;
  const st = k.statement;
  openSheet(k.name, `<form data-submit="fnCardSave" data-id="${id}">
    <div class="two"><label class="field"><span>${esc(t("fnClosingDay"))}</span><input name="closing" type="number" inputmode="numeric" min="1" max="31" value="${k.closing_day ?? ""}"></label>
    <label class="field"><span>${esc(t("fnDueDay"))}</span><input name="due" type="number" inputmode="numeric" min="1" max="31" value="${k.due_day ?? ""}"></label></div>
    <label class="field"><span>${esc(t("fnCreditLimit"))}</span><input name="limit" inputmode="decimal" value="${centsToInput(k.limit_cents)}"></label>
    <details class="more"><summary data-act="fnStmt">${esc(t("fnStatement"))}${st ? ` <span class="muted">${esc(dateLabel(st.closing_date))}</span>` : ""}</summary>
      <div class="more-body">
      ${dateField("stClosing", t("fnClosedOn"), st ? st.closing_date : "")}
      ${dateField("stDue", t("fnDueOn"), st && st.due_date ? st.due_date : "")}
      <div class="two"><label class="field"><span>${esc(t("fnMinPay"))}</span><input name="stMin" inputmode="decimal" value="${st ? centsToInput(st.min_cents) : ""}"></label>
      <label class="field"><span>${esc(t("fnFullPay"))}</span><input name="stFull" inputmode="decimal" value="${st ? centsToInput(st.full_cents) : ""}"></label></div>
      </div>
    </details>
    <p class="hint">${esc(t("fnCardHint"))}</p>
    <p class="err" id="fnErr" hidden></p>
    <div class="btns"><button class="btn primary">${esc(t("save"))}</button></div>
    <div class="btns"><button type="button" class="btn danger" data-act="fnCardWipe" data-id="${id}">${esc(t("fnCardWipe"))}</button></div>
    <p class="hint" id="fnWipeNote" hidden>${esc(t("fnCardWipeNote", { name: k.name }))}</p></form>`);
};

/**
 * F24: a date on its own row, as in the iOS Settings app: the date text on the left, and "Elegir fecha" in muted
 * text while it is empty (an iOS date input shows no placeholder). js/ui.js keeps the hint in step as she picks.
 */
function dateField(name, label, value) {
  return `<label class="field datefield"><span>${esc(label)}</span><input name="${name}" type="date" value="${esc(value)}">
    <em class="datehint"${value ? " hidden" : ""}>${esc(t("pickDate"))}</em></label>`;
}

/** F30: "Último estado de cuenta" opens and closes with a smooth height, so the sheet grows instead of jumping. */
ACT.fnStmt = (summary) => {
  const d = summary.parentElement;
  const panel = d.querySelector(".more-body");
  if (d.classList.contains("is-open")) {
    d.classList.remove("is-open");
    slidePanel(panel, false, () => (d.open = false));
  } else {
    d.classList.add("is-open");
    d.open = true;
    slidePanel(panel, true);
  }
};

/** "Borrar datos de esta tarjeta": first tap says exactly what goes, the second one does it. Movements stay. */
ACT.fnCardWipe = async (el) => {
  const id = Number(el.dataset.id);
  const note = document.getElementById("fnWipeNote");
  if (!el.classList.contains("armed")) {
    el.classList.add("armed");
    el.textContent = t("fnCardWipeSure");
    if (note) note.hidden = false;
    return;
  }
  el.disabled = true;
  try {
    await api(`/cards/${id}`, { method: "PUT", body: { closing_day: null, due_day: null, limit_cents: null } });
    await api(`/cards/${id}/statement`, { method: "DELETE" });
    forgetCards();
    closeSheet();
    toast(t("fnCardWiped"));
    render();
  } catch (e) {
    el.disabled = false;
    toast(errText(e));
  }
};

const dayOrNull = (v) => {
  const n = Number(String(v).trim());
  return String(v).trim() && Number.isInteger(n) && n >= 1 && n <= 31 ? n : null;
};
const centsOrNull = (v) => (String(v).trim() ? parseCents(v) : null);
/** A statement payment: empty is "not known", 0 is a real answer (the card was paid off). undefined = unreadable. */
const payOrNull = (v) => (String(v).trim() ? (parseCents(v, { zero: true }) ?? undefined) : null);

ACT.fnCardSave = async (form) => {
  const id = Number(form.dataset.id);
  const err = form.querySelector("#fnErr");
  const bad = (msg) => {
    err.textContent = msg;
    err.hidden = false;
  };
  if ((form.closing.value.trim() && !dayOrNull(form.closing.value)) || (form.due.value.trim() && !dayOrNull(form.due.value))) return bad(t("fnBadDay"));
  const limit = centsOrNull(form.limit.value);
  if (form.limit.value.trim() && !limit) return bad(t("invalidAmount"));
  // every check runs before anything is sent, so a refused field never leaves the other half saved
  const min = payOrNull(form.stMin.value);
  const full = payOrNull(form.stFull.value);
  if (min === undefined || full === undefined) return bad(t("invalidAmount"));
  const closing = form.stClosing.value;
  const dueOn = form.stDue.value;
  if (closing && dueOn && dueOn < closing) return bad(t("fnDueBeforeClose"));
  if (!closing && (dueOn || min != null || full != null)) return bad(t("fnNeedClosing"));
  const k = cardsNow.find((x) => x.account_id === id);
  const st = k && k.statement;
  if (form.dataset.busy) return;
  form.dataset.busy = "1";
  try {
    await api(`/cards/${id}`, { method: "PUT", body: { closing_day: dayOrNull(form.closing.value), due_day: dayOrNull(form.due.value), limit_cents: limit } });
    if (closing) {
      await api(`/cards/${id}/statement`, { method: "POST", body: {
        closing_date: closing, due_date: dueOn || null, min_cents: min, full_cents: full, id: st ? st.id : null,
      } });
    } else if (st) {
      // she emptied Fecha de corte: the statement she had open goes
      await api(`/cards/${id}/statement?st=${Number(st.id)}`, { method: "DELETE" });
    }
    forgetCards(); // step 2 shows the same two days
    closeSheet();
    toast(t("saved"));
    render();
  } catch (e) {
    delete form.dataset.busy;
    bad(e.code === "invalid:due_date" ? t("fnDueBeforeClose") : errText(e));
  }
};

// ---------- step 2 ("¿Con qué pagas?"): the two days under each card ----------
let known = null; // account id -> {closing_day, due_day}, from /api/cards
let loading = null;
function loadKnown() {
  if (loading) return loading;
  loading = api("/cards")
    .then((r) => {
      known = new Map(r.cards.map((k) => [k.account_id, k]));
      for (const box of document.querySelectorAll("[data-fn-card]")) {
        const k = known.get(Number(box.dataset.fnCard));
        if (!k) continue;
        for (const f of ["closing_day", "due_day"]) {
          const input = box.querySelector(`[data-fn-day="${f}"]`);
          if (input && !input.value && document.activeElement !== input && k[f]) input.value = k[f];
        }
      }
    })
    .catch(() => {})
    .finally(() => setTimeout(() => (loading = null), 0));
  return loading;
}

slots.cardDates = (a) => {
  const k = known && known.get(a.id);
  if (!k) setTimeout(loadKnown, 0); // not read yet, or a card added since

  return `<fieldset class="fn-card-days" data-fn-card="${a.id}"><legend>${esc(t("fnDaysFor", { name: a.name }))}</legend>
    <div class="two"><label class="field"><span>${esc(t("fnClosingDay"))}</span><input type="number" inputmode="numeric" min="1" max="31" data-fn-day="closing_day" value="${k && k.closing_day ? k.closing_day : ""}"></label>
    <label class="field"><span>${esc(t("fnDueDay"))}</span><input type="number" inputmode="numeric" min="1" max="31" data-fn-day="due_day" value="${k && k.due_day ? k.due_day : ""}"></label></div></fieldset>`;
};

document.addEventListener("change", async (e) => {
  const input = e.target.closest ? e.target.closest("[data-fn-day]") : null;
  if (!input) return;
  const box = input.closest("[data-fn-card]");
  const id = Number(box.dataset.fnCard);
  const field = input.dataset.fnDay === "due_day" ? "due_day" : "closing_day";
  const day = dayOrNull(input.value);
  if (input.value.trim() && !day) return toast(t("fnBadDay"));
  try {
    await api(`/cards/${id}`, { method: "PUT", body: { [field]: day } });
    if (known) known.set(id, { ...(known.get(id) || {}), [field]: day });
    toast(t("saved"));
  } catch (err) {
    toast(errText(err));
  }
});

/** Forget step 2's copy when the account list may have changed (a new card was just added). */
export const forgetCards = () => (known = null);
