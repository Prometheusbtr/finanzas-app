// Add a purchase, and the "same purchase?" question.
import { S, app, sheet, VIEWS, ACT } from "../state.js";
import { t } from "../i18n.js";
import { esc, parseCents, dateLabel, randomId, splitTags } from "../format.js";
import { api } from "../api.js";
import { catById, accById, activeAccounts, topCats } from "../data.js";
import { toast, errText, openSheet, closeSheet, pickCategory, movRow } from "../ui.js";
import { paint, navAs } from "../motion.js";
import { catTile } from "../look.js";
import { render } from "../router.js";
import { fxFields, readFx } from "../fx.js"; // Funciones: "Otra moneda"

let A = null; // the purchase being typed
function newDraft() {
  const accs = activeAccounts();
  const last = S.boot.last_account_id && accById(S.boot.last_account_id) && !accById(S.boot.last_account_id).archived ? S.boot.last_account_id : accs[0] && accs[0].id;
  return { client_id: randomId(), category_id: null, suggested: false, account_id: last || null, tipo: "gasto" };
}
VIEWS["/agregar"] = async () => {
  A = newDraft();
  const tipos = ["gasto", "ingreso", "interno", "abono"];
  await paint(() => {
  app.innerHTML = `<form data-submit="saveAdd" autocomplete="off">
    <div class="pagehead"><h1>${esc(t("add"))}</h1><a href="#/" data-nav="fade">${esc(t("cancel"))}</a></div>
    <input id="amt" class="amount-input" inputmode="decimal" placeholder="$0.00" aria-label="${esc(t("amount"))}" enterkeyhint="done">
    <div class="section-label">${esc(t("category"))}</div>
    <div class="chips" id="catChips"></div>
    <p class="hint" id="catHint">${esc(t("noCategoryHint"))}</p>
    <div class="section-label">${esc(t("account"))}</div>
    <div class="chips" id="accChips">${activeAccounts()
      .map((a) => `<button type="button" class="chip" data-act="addAcc" data-id="${a.id}" aria-pressed="${a.id === A.account_id}">${esc(a.name)}</button>`)
      .join("")}</div>
    <label class="field"><span>${esc(t("where"))}</span><input id="comercio" maxlength="200" placeholder="${esc(t("wherePh"))}"></label>
    <details class="more"><summary>${esc(t("more"))}</summary>
      <div class="section-label">${esc(t("type"))}</div>
      <div class="seg" id="tipoSeg">${tipos.map((x) => `<button type="button" data-act="addTipo" data-v="${x}" aria-pressed="${x === "gasto"}">${esc(t("tipo_" + x))}</button>`).join("")}</div>
      <div class="two"><label class="field"><span>${esc(t("date"))}</span><input id="fecha" type="date" value="${S.boot.today}" max="${S.boot.today}"></label>
      <label class="field"><span>${esc(t("time"))}</span><input id="hora" type="time"></label></div>
      <label class="field"><span>${esc(t("note"))}</span><input id="nota" maxlength="500"></label>
      <label class="field"><span>${esc(t("tags"))}</span><input id="tags" placeholder="${esc(t("tagsHint"))}"></label>
    </details>
    ${fxFields(null)}
    <p class="err" id="addErr" hidden></p>
    <div class="savebar"><button class="btn primary block" id="saveBtn">${esc(t("save"))}</button></div>
  </form>`;
  drawCatChips();
  });
  const comercio = document.getElementById("comercio");
  let timer;
  comercio.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      if (A.category_id && !A.suggested) return; // the user already chose
      const v = comercio.value.trim();
      // F17: a suggestion is only for the name it came from: a shorter name, or one with no suggestion, clears it,
      // so a stale hint is never saved (and never learned as a shop rule).
      const clear = () => {
        if (A.suggested) {
          A.category_id = null;
          A.suggested = false;
          drawCatChips();
        }
      };
      if (v.length < 3) return clear();
      try {
        const r = await api("/suggest?comercio=" + encodeURIComponent(v));
        if (comercio.value.trim() !== v || (A.category_id && !A.suggested)) return; // a late answer, or she chose meanwhile
        if (r.category_id) {
          A.category_id = r.category_id;
          A.suggested = true;
          drawCatChips();
        } else clear();
      } catch {}
    }, 350);
  });
  // On a computer, start in the amount box. On a phone the keyboard opens when the box is tapped.
  if (!matchMedia("(pointer: coarse)").matches) setTimeout(() => document.getElementById("amt").focus(), 50);
};
function drawCatChips() {
  const list = topCats(8);
  const sel = A.category_id && catById(A.category_id);
  if (sel && !list.includes(sel)) list.unshift(sel);
  document.getElementById("catChips").innerHTML =
    list.map((c) => `<button type="button" class="chip" data-act="addCat" data-id="${c.id}" aria-pressed="${c.id === A.category_id}">${catTile(c.id, "sm")}${esc(c.name)}</button>`).join("") +
    `<button type="button" class="chip more" data-act="addCatAll">${esc(t("allCategories"))}</button>`;
  document.getElementById("catHint").textContent = A.category_id ? (A.suggested ? t("suggested") : "") : t("noCategoryHint");
}
ACT.addCat = (el) => {
  const id = Number(el.dataset.id);
  A.category_id = A.category_id === id && !A.suggested ? null : id;
  A.suggested = false;
  drawCatChips();
};
ACT.addCatAll = async () => {
  const id = await pickCategory(A.category_id);
  if (id) {
    A.category_id = id;
    A.suggested = false;
    drawCatChips();
  }
};
ACT.addAcc = (el) => {
  A.account_id = Number(el.dataset.id);
  document.querySelectorAll("#accChips .chip").forEach((c) => c.setAttribute("aria-pressed", String(Number(c.dataset.id) === A.account_id)));
};
ACT.addTipo = (el) => {
  A.tipo = el.dataset.v;
  document.querySelectorAll("#tipoSeg button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.v === A.tipo)));
};
ACT.saveAdd = async () => {
  const err = document.getElementById("addErr");
  const fx = readFx(app, parseCents(document.getElementById("amt").value)); // Funciones: dollars from the rate when left empty
  const cents = fx.usdCents;
  err.hidden = true;
  if (fx.error || !cents) {
    err.textContent = fx.error || t("invalidAmount");
    err.hidden = false;
    document.getElementById("amt").focus();
    return;
  }
  const btn = document.getElementById("saveBtn");
  btn.disabled = true;
  const hora = document.getElementById("hora").value;
  const fecha = document.getElementById("fecha").value || S.boot.today;
  const body = {
    client_id: A.client_id, amount_cents: cents, account_id: A.account_id, category_id: A.category_id,
    comercio: document.getElementById("comercio").value.trim(), tipo: A.tipo, fecha,
    nota: document.getElementById("nota").value.trim(), tags: splitTags(document.getElementById("tags").value),
  };
  if (hora) body.hora = hora;
  if (fx.fx) body.fx = fx.fx;
  try {
    const r = await api("/movements", { method: "POST", body });
    S.boot.last_account_id = A.account_id;
    if (r.possible_duplicates && r.possible_duplicates.length) {
      askMerge(r.movement, r.possible_duplicates);
    } else {
      toast(t("saved"));
      goHome();
    }
  } catch (e) {
    err.textContent = errText(e);
    err.hidden = false;
  } finally {
    btn.disabled = false;
  }
};
/**
 * Home after a save, with the numbers after it. Home may have been tapped while the save was on its way: its
 * hash is then "#/" already, setting it again does not render, and what it shows is from before the save.
 */
function goHome() {
  S.boot = null; // refresh counts and most-used categories
  navAs("fade");
  if (location.hash === "#/") render();
  else location.hash = "#/";
}
function askMerge(manual, bankRows) {
  const body = `<p>${esc(t("sameBody"))}</p>
    ${bankRows.map((b) => `<div class="list">${movRow(b)}</div><p class="small muted">${esc(dateLabel(b.fecha))} · ${esc(b.origen)}</p>
      <div class="btns"><button class="btn primary" data-act="mergeNow" data-manual="${manual.id}" data-bank="${b.id}">${esc(t("merge"))}</button></div>`).join("")}
    <div class="btns"><button class="btn" data-act="mergeSkip">${esc(t("keepBoth"))}</button></div>`;
  openSheet(t("sameQ"), body);
  sheet.addEventListener("close", () => {
    if (location.hash === "#/agregar" || location.hash === "#/") goHome();
  }, { once: true });
}
ACT.mergeNow = async (el) => {
  try {
    await api(`/movements/${el.dataset.manual}/merge`, { method: "POST", body: { bank_id: Number(el.dataset.bank) } });
    toast(t("merged"));
  } catch (e) {
    toast(errText(e));
  }
  closeSheet();
};
ACT.mergeSkip = () => {
  toast(t("saved"));
  closeSheet();
};
