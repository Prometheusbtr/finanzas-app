// Shared pieces of screen: toast, error text, bottom sheet, category picker, movement row.
import { S, sheet, ACT } from "./state.js";
import { t } from "./i18n.js";
import { esc, money, applyBars } from "./format.js";
import { activeCats, catName, accName } from "./data.js";
import { icon, tile, groupLook, movTile } from "./look.js";
import { sheetIn, sheetOut, sheetSettle } from "./motion.js";

/**
 * "‹ Volver" at the top left of a screen inside Más. It goes back to Más, or to Home when Home opened it;
 * screen readers hear where ("Volver a Más"). parents: the screens it may have come from, first = the default.
 * The tap is handled by ACT.back in router.js.
 */
export function backBtn(parents = ["/mas"]) {
  const to = parents.includes(S.from) ? S.from : parents[0];
  const name = t(to === "/" ? "home" : to === "/ajustes" ? "settings" : "moreTab");
  return `<button class="back" data-act="back" data-to="${esc(to)}" aria-label="${esc(t("backTo", { x: name }))}">${icon("chevron-left")}<span>${esc(t("back"))}</span></button>`;
}

let toastTimer;
export function toast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
}
/** "1 día" / "3 días": key + "1" or key + "N" in i18n. */
export const tn = (key, n) => t(key + (n === 1 ? "1" : "N"), { n });
/** t() for a sentence with markup in it: the sentence is escaped, each var is HTML the caller already escaped. */
export function tHtml(key, vars) {
  let s = esc(t(key));
  for (const [k, v] of Object.entries(vars || {})) s = s.split(`{${k}}`).join(v);
  return s;
}
export function errText(e) {
  if (e && e.code === "offline") return t("offline");
  if (e && e.code === "name_taken") return t("nameTaken");
  if (e && e.code === "reauth_cancelled") return t("raCancelled");
  if (e && e.code === "has_shares") { // F14
    const x = e.data && e.data.shares_cents;
    return x ? t("hasShares", { x: money(x) }) : t("hasSharesLine");
  }
  return t("error", { e: (e && e.code) || "?" });
}
/** An error for a form in a sheet. The fresh-check sheet (js/lock.js) takes the form's place, so when the form is
 * gone the message shows as a toast (and that sheet, if still up after the check, closes) instead of nowhere. */
export function formError(form, errEl, msg) {
  if (form.isConnected) {
    errEl.hidden = false;
    errEl.textContent = msg;
    return;
  }
  closeSheet();
  toast(msg);
}

// ---------- bottom sheet ----------
// A glass top (grab handle, title, close) over a solid body. It slides up on open and down before
// dialog.close(). Dragging the top down past a third of its height, or flicking it, closes it.
let closing = null; // the slide-down while it runs
export function openSheet(title, bodyHtml) {
  sheet.innerHTML = `<div class="sheet-top"><span class="grab" aria-hidden="true"></span><div class="sheet-head"><h1>${esc(title)}</h1>
    <button class="iconbtn" data-act="close" aria-label="${esc(t("close"))}">${icon("x")}</button></div></div>
    <div class="sheet-body">${bodyHtml}</div>`;
  applyBars(sheet);
  if (closing) {
    // a new sheet while the old one slides away: keep it up
    const a = closing;
    closing = null;
    a.cancel();
    sheet.classList.remove("closing");
  }
  if (!sheet.open) {
    sheet.showModal();
    sheetIn(sheet);
  }
  sheet.scrollTop = 0; // the dialog keeps the last sheet's scroll otherwise (it only scrolls while open)
}
/** Close the sheet: slide down, then dialog.close() (which fires the "close" event the screens listen for). */
export function closeSheet(fromY) {
  if (!sheet.open || closing) return;
  sheet.classList.add("closing");
  const a = sheetOut(sheet, fromY);
  const finish = () => {
    if (closing !== a) return;
    closing = null;
    sheet.classList.remove("closing");
    if (sheet.open) sheet.close();
    if (a) a.cancel(); // drop the held end frame so the next open starts clean
  };
  closing = a;
  if (!a) {
    closing = null;
    sheet.classList.remove("closing");
    sheet.close();
    return;
  }
  a.finished.then(finish, () => {});
}
// Escape: the same slide instead of the instant close.
sheet.addEventListener("cancel", (e) => {
  e.preventDefault();
  closeSheet();
});
// Drag the glass top down to close.
let drag = null;
sheet.addEventListener("pointerdown", (e) => {
  const top = e.target.closest(".sheet-top");
  if (!top || e.target.closest("button, a, input, select, textarea") || closing || e.button > 0) return;
  drag = { id: e.pointerId, y0: e.clientY, t0: e.timeStamp, dy: 0, h: sheet.getBoundingClientRect().height };
  top.setPointerCapture(e.pointerId);
});
sheet.addEventListener("pointermove", (e) => {
  if (!drag || e.pointerId !== drag.id) return;
  drag.dy = Math.max(0, e.clientY - drag.y0);
  sheet.style.transform = drag.dy ? `translateY(${drag.dy}px)` : "";
});
const endDrag = (e) => {
  if (!drag || e.pointerId !== drag.id) return;
  const { dy, t0, h } = drag;
  drag = null;
  sheet.style.transform = "";
  if (!dy) return;
  const fast = dy / Math.max(1, e.timeStamp - t0) > 0.6; // px per ms: a flick
  if (dy > h / 3 || (fast && dy > 24)) closeSheet(dy);
  else sheetSettle(sheet, dy);
};
sheet.addEventListener("pointerup", endDrag);
sheet.addEventListener("pointercancel", endDrag);

// ---------- category picker ----------
let pickResolve = null;
export function pickCategory(current) {
  return new Promise((resolve) => {
    pickResolve = resolve;
    const groups = S.boot.groups.filter((g) => !g.archived);
    const body = groups
      .map((g) => {
        const cats = activeCats().filter((c) => c.group_id === g.id);
        if (!cats.length) return "";
        const [ic, color] = groupLook(g.name);
        return `<div class="pick-group">${tile(ic, color, "sm")}<h3>${esc(g.name)}</h3></div><div class="chips">${cats
          .map((c) => `<button class="chip" data-act="picked" data-id="${c.id}" aria-pressed="${c.id === current}">${esc(c.name)}</button>`)
          .join("")}</div>`;
      })
      .join("");
    openSheet(t("pickCategory"), body);
    sheet.addEventListener("close", () => {
      if (pickResolve) {
        pickResolve(null);
        pickResolve = null;
      }
    }, { once: true });
  });
}
ACT.picked = (el) => {
  const r = pickResolve;
  pickResolve = null;
  closeSheet();
  if (r) r(Number(el.dataset.id));
};

// F24: the "Elegir fecha" hint on an empty date field (js/screens/tarjetas.js dateField) follows the value.
const dateHint = (e) => {
  const el = e.target;
  if (el && el.type === "date" && el.parentElement) {
    const h = el.parentElement.querySelector(".datehint");
    if (h) h.hidden = !!el.value;
  }
};
document.addEventListener("input", dateHint);
document.addEventListener("change", dateHint);

/**
 * One movement as a ledger row. short (Movimientos, Melvin Nov 25 2026): the title and, under it, only how it was
 * paid (Efectivo, the card or the account), with no category repeat and no time; a bank row titled by its shop
 * still shows its category as the tile. Revisar, Agregar and Importar keep the category under the row, because
 * there it is what you are checking.
 */
export function movRow(m, act, opts = {}) {
  const cls = m.tipo;
  const sign = m.tipo === "ingreso" ? money(m.amount_cents, true) : m.tipo === "abono" ? money(-m.amount_cents) : money(m.amount_cents);
  const spend = m.tipo === "gasto" || m.tipo === "abono";
  const sub = opts.short
    ? accName(m.account_id)
    : [spend ? catName(m.category_id) : t("tipo_" + m.tipo), accName(m.account_id), m.hora || ""].filter(Boolean).join(" · ");
  const title = m.comercio || (spend || !opts.short ? catName(m.category_id) : t("tipo_" + m.tipo));
  const tag = act ? "button" : "div";
  return `<${tag} class="row" ${act ? `data-act="${act}" data-id="${m.id}"` : ""}>${movTile(m)}
    <div class="grow"><div class="title">${esc(title)}</div>${sub ? `<div class="sub">${esc(sub)}</div>` : ""}</div>
    <div class="amt ${cls}">${sign}</div></${tag}>`;
}
