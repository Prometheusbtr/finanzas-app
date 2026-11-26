// Movements: filters, list grouped by day, edit sheet.
import { S, app, VIEWS, ACT, PARTS } from "../state.js";
import { t } from "../i18n.js";
import { esc, money, parseCents, centsToInput, dateLabel, monthLabel, shiftMonth, splitTags } from "../format.js";
import { api } from "../api.js";
import { showCached, setBadge } from "../data.js";
import { toast, errText, openSheet, closeSheet, movRow } from "../ui.js";
import { paint, riseIn } from "../motion.js";
import { icon } from "../look.js";
import { fxFields, readFx } from "../fx.js"; // Funciones: "Otra moneda"
import { shareRow } from "./personas.js"; // Funciones: share a purchase with someone

const PAGE = 100;
const filtersFrom = (params) => ({
  month: params.get("month") ?? S.boot.today.slice(0, 7), cat: params.get("cat") || "", acc: params.get("acc") || "",
  tipo: params.get("tipo") || "", q: params.get("q") || "", estado: params.get("estado") === "revisar" ? "revisar" : "",
});
/** The /api/movements query for these filters, from `offset`. */
function query(f, offset) {
  const p = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
  if (f.month) p.set("month", f.month);
  if (f.q) p.set("q", f.q);
  if (f.tipo) p.set("tipo", f.tipo);
  if (f.acc) p.set("account_id", f.acc);
  if (f.estado) p.set("estado", f.estado);
  if (f.cat.startsWith("g:")) p.set("group_id", f.cat.slice(2));
  if (f.cat.startsWith("c:")) p.set("category_id", f.cat.slice(2));
  return p.toString();
}
// Only the first page of the filters the screen opens with is kept in memory (filter changes typed on the
// screen always load fresh).
const firstPart = (f) => {
  const q = query(f, 0);
  return ["movs:" + q, () => api("/movements?" + q)];
};
PARTS["/movimientos"] = (params) => [firstPart(filtersFrom(params))];
let firstShown = null; // the S.list drawn from that first page, so a quiet refresh replaces only that one

VIEWS["/movimientos"] = (params) => {
  const f = filtersFrom(params);
  S.filters = f;
  return showCached([firstPart(f)], ([r], quiet) => {
    if (quiet) {
      // fresher first page: only while the list on screen is still that page (no filter change, no "Cargar más")
      if (!firstShown || S.list !== firstShown.list || S.list.offset !== firstShown.len) return;
      useFirstPage(r);
      drawMovements();
      return;
    }
    useFirstPage(r);
    return drawScreen(f, params);
  });
};
function useFirstPage(r) {
  S.list = { items: [...r.items], offset: r.items.length, has_more: r.has_more };
  firstShown = { list: S.list, len: r.items.length };
}

async function drawScreen(f, params) {
  const months = [];
  for (let i = 0; i < 13; i++) months.push(shiftMonth(S.boot.today.slice(0, 7), -i));
  const opt = (v, label, cur) => `<option value="${esc(v)}" ${String(v) === String(cur) ? "selected" : ""}>${esc(label)}</option>`;
  const catOpts = S.boot.groups
    .map((g) => {
      const cats = S.boot.categories.filter((c) => c.group_id === g.id);
      return `<optgroup label="${esc(g.name)}">${opt("g:" + g.id, t("wholeGroup", { g: g.name }), f.cat)}${cats.map((c) => opt("c:" + c.id, c.name, f.cat)).join("")}</optgroup>`;
    })
    .join("");
  const tipos = ["gasto", "abono", "ingreso", "interno", "rechazado", "ignorado"];
  const n = S.boot.review_count;
  // the first page is in S.list before the screen swaps, so the change carries the full list
  await paint(() => {
  app.innerHTML = `<h1>${esc(t("movements"))}</h1>
    <div class="search">${icon("search")}<input id="q" type="search" placeholder="${esc(t("search"))}" aria-label="${esc(t("search"))}" value="${esc(f.q)}" enterkeyhint="search"></div>
    <div class="chips quick" id="estadoChips">
      <button class="chip" data-act="movEstado" data-v="" aria-pressed="${!f.estado}">${esc(t("allMovs"))}</button>
      <button class="chip" data-act="movEstado" data-v="revisar" aria-pressed="${f.estado === "revisar"}">${esc(t("reviewTitle"))}${n ? ` <span class="count">${n > 99 ? "99+" : n}</span>` : ""}</button>
      <a class="chip" href="#/importar">${icon("plus")}${esc(t("impShort"))}</a>
    </div>
    <div class="filters">
      <select id="fMonth" aria-label="${esc(t("month"))}">${opt("", t("allMonths"), f.month)}${months.map((m) => opt(m, monthLabel(m), f.month)).join("")}</select>
      <select id="fTipo" aria-label="${esc(t("type"))}">${opt("", t("allTypes"), f.tipo)}${opt("gastos", t("spendingTypes"), f.tipo)}${tipos.map((x) => opt(x, t("tipo_" + x), f.tipo)).join("")}</select>
      <select id="fCat" aria-label="${esc(t("category"))}">${opt("", t("allCats"), f.cat)}${catOpts}</select>
      <select id="fAcc" aria-label="${esc(t("account"))}">${opt("", t("allAccounts"), f.acc)}${S.boot.accounts.map((a) => opt(a.id, a.name, f.acc)).join("")}</select>
    </div>
    <div id="movList"></div>`;
  drawMovements();
  });
  riseIn([...app.querySelectorAll("#movList .row")]);
  const onChange = () => {
    S.filters = {
      month: document.getElementById("fMonth").value, tipo: document.getElementById("fTipo").value,
      cat: document.getElementById("fCat").value, acc: document.getElementById("fAcc").value, q: document.getElementById("q").value.trim(),
      estado: S.filters.estado,
    };
    applyFilters();
  };
  ["fMonth", "fTipo", "fCat", "fAcc"].forEach((id) => document.getElementById(id).addEventListener("change", onChange));
  let timer;
  document.getElementById("q").addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(onChange, 300);
  });
  // From a day bar in Análisis: load down to that day, then bring its header into view.
  const day = params.get("day");
  if (day && /^\d{4}-\d{2}-\d{2}$/.test(day)) {
    for (let i = 0; i < 20 && S.list.has_more && S.list.items.length && S.list.items[S.list.items.length - 1].fecha >= day; i++) await loadMovements(false);
    setTimeout(() => focusDay(day), 0); // after the router scrolls to the top
  }
}
function applyFilters() {
  const qs = new URLSearchParams(Object.entries(S.filters).filter(([k, v]) => v || k === "month")).toString();
  history.replaceState(history.state, "", "#/movimientos?" + qs); // keeps the history index (js/router.js)
  loadMovements(true);
}
function focusDay(day) {
  const el = document.querySelector(`.day[data-day="${day}"]`);
  if (!el) return;
  el.classList.add("is-focus");
  window.scrollTo(0, Math.max(0, el.getBoundingClientRect().top + window.scrollY - 12));
}
ACT.movEstado = (el) => {
  S.filters.estado = el.dataset.v === "revisar" ? "revisar" : "";
  document.querySelectorAll('[data-act="movEstado"]').forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.v === S.filters.estado)));
  applyFilters();
};
async function loadMovements(reset, draw = true) {
  const f = S.filters;
  if (reset) S.list = { items: [], offset: 0, has_more: false };
  const list = S.list;
  if (list.loading) return list.loading; // F19: a second tap on "Cargar más" waits for the same page
  list.loading = (async () => {
    const r = await api("/movements?" + query(f, list.offset));
    if (S.list !== list) return; // the filters changed again while this page loaded: that newer list wins
    const have = new Set(list.items.map((m) => m.id));
    list.items.push(...r.items.filter((m) => !have.has(m.id)));
    list.offset += r.items.length;
    list.has_more = r.has_more;
    if (draw) drawMovements();
  })().finally(() => (list.loading = null));
  return list.loading;
}

/**
 * F34: whether an edited movement still belongs in the list under the screen's filters (the same tests the server
 * runs; the search text is left to the next load, since the server matches it in more places than the row shows).
 */
function fits(m, f) {
  if (f.month && m.fecha.slice(0, 7) !== f.month) return false;
  if (f.estado && m.estado !== f.estado) return false;
  if (f.acc && m.account_id !== Number(f.acc)) return false;
  if (f.tipo === "gastos" ? m.tipo !== "gasto" && m.tipo !== "abono" : f.tipo && m.tipo !== f.tipo) return false;
  if (f.cat.startsWith("c:") && m.category_id !== Number(f.cat.slice(2))) return false;
  if (f.cat.startsWith("g:")) {
    const c = S.boot.categories.find((x) => x.id === m.category_id);
    if (!c || c.group_id !== Number(f.cat.slice(2))) return false;
  }
  return true;
}
function drawMovements() {
  const el = document.getElementById("movList");
  if (!el) return;
  const items = S.list.items;
  if (!items.length) {
    el.innerHTML = `<p class="empty">${esc(S.filters.estado ? t("reviewEmpty") : t("noResults"))}</p>`;
    return;
  }
  const days = new Map();
  for (const m of items) {
    if (!days.has(m.fecha)) days.set(m.fecha, []);
    days.get(m.fecha).push(m);
  }
  el.innerHTML =
    [...days.entries()]
      .map(([fecha, ms]) => {
        const total = ms.reduce((s, m) => s + (m.tipo === "gasto" ? m.amount_cents : m.tipo === "abono" ? -m.amount_cents : 0), 0);
        return `<div class="day" data-day="${esc(fecha)}"><span>${esc(dateLabel(fecha, { weekday: "long", day: "numeric", month: "long" }))}</span><span class="num">${total ? money(total) : ""}</span></div>
          <div class="list">${ms.map((m) => movRow(m, "editMov", { short: true })).join("")}</div>`;
      })
      .join("") + (S.list.has_more ? `<div class="btns"><button class="btn" data-act="moreMov">${esc(t("loadMore"))}</button></div>` : "");
}
ACT.moreMov = async (btn) => {
  btn.disabled = true;
  try {
    await loadMovements(false);
  } catch (e) {
    btn.disabled = false;
    toast(errText(e));
  }
};

ACT.editMov = (el) => {
  const m = S.list.items.find((x) => x.id === Number(el.dataset.id));
  if (!m) return;
  const tipos = ["gasto", "abono", "ingreso", "interno", "rechazado", "ignorado"];
  const catOpts = `<option value="">${esc(t("none"))}</option>` + S.boot.groups
    .map((g) => `<optgroup label="${esc(g.name)}">${S.boot.categories.filter((c) => c.group_id === g.id && (!c.archived || c.id === m.category_id))
      .map((c) => `<option value="${c.id}" ${c.id === m.category_id ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</optgroup>`)
    .join("");
  openSheet(t("edit"), `<form data-submit="saveMov" data-id="${m.id}">
    <label class="field"><span>${esc(t("amount"))}</span><input name="amount" inputmode="decimal" value="${centsToInput(m.amount_cents)}"></label>
    <div class="two"><label class="field"><span>${esc(t("date"))}</span><input name="fecha" type="date" value="${esc(m.fecha)}"></label>
    <label class="field"><span>${esc(t("time"))}</span><input name="hora" type="time" value="${esc(m.hora || "")}"></label></div>
    <label class="field"><span>${esc(t("where"))}</span><input name="comercio" maxlength="200" value="${esc(m.comercio)}"></label>
    <div class="two"><label class="field"><span>${esc(t("type"))}</span><select name="tipo">${tipos.map((x) => `<option value="${x}" ${x === m.tipo ? "selected" : ""}>${esc(t("tipo_" + x))}</option>`).join("")}</select></label>
    <label class="field"><span>${esc(t("account"))}</span><select name="account">${m.account_id == null ? `<option value="" selected>${esc(t("none"))}</option>` : ""}${S.boot.accounts.map((a) => `<option value="${a.id}" ${a.id === m.account_id ? "selected" : ""}>${esc(a.name)}</option>`).join("")}</select></label></div>
    <label class="field"><span>${esc(t("category"))}</span><select name="category">${catOpts}</select></label>
    <label class="field"><span>${esc(t("note"))}</span><input name="nota" maxlength="500" value="${esc(m.nota)}"></label>
    <label class="field"><span>${esc(t("tags"))}</span><input name="tags" value="${esc(m.tags.join(", "))}" placeholder="${esc(t("tagsHint"))}"></label>
    ${fxFields(m.fx)}${shareRow(m)}
    <p class="small muted origin">${esc(t("origin"))}: ${esc(m.origen)}</p>
    ${m.raw ? `<details><summary class="small muted">${esc(t("original"))}</summary><pre class="raw">${esc(m.raw)}</pre></details>` : ""}
    <p class="err" id="movErr" hidden></p>
    <div class="btns"><button class="btn primary">${esc(t("save"))}</button>
    <button type="button" class="btn danger" data-act="delMov" data-id="${m.id}">${esc(t("delete"))}</button></div>
  </form>`);
};
ACT.saveMov = async (form) => {
  const id = Number(form.dataset.id);
  const err = form.querySelector("#movErr");
  const fx = readFx(form, parseCents(form.amount.value)); // Funciones
  const cents = fx.usdCents;
  if (fx.error || !cents) {
    err.textContent = fx.error || t("invalidAmount");
    err.hidden = false;
    return;
  }
  const body = {
    amount_cents: cents, fecha: form.fecha.value, hora: form.hora.value || null, comercio: form.comercio.value.trim(),
    tipo: form.tipo.value, account_id: Number(form.account.value) || null, category_id: Number(form.category.value) || null,
    nota: form.nota.value.trim(), tags: splitTags(form.tags.value), fx: fx.fx,
  };
  if (form.dataset.busy) return; // a second tap on Guardar while the first one saves
  form.dataset.busy = "1";
  const btn = form.querySelector("button.primary");
  if (btn) btn.disabled = true;
  try {
    const r = await api(`/movements/${id}`, { method: "PUT", body });
    const i = S.list.items.findIndex((x) => x.id === id);
    const before = i >= 0 ? S.list.items[i] : null;
    if (i >= 0) {
      if (fits(r.movement, S.filters)) S.list.items[i] = r.movement;
      else {
        // it left the server's list too, so the rows after it moved up one: the next page starts one earlier
        // (else "Cargar más" would skip a row; a row seen twice is dropped by its id)
        S.list.items.splice(i, 1);
        S.list.offset = Math.max(0, S.list.offset - 1);
      }
    }
    if (before && before.estado !== r.movement.estado && S.boot) {
      setBadge(Math.max(0, (S.boot.review_count || 0) + (r.movement.estado === "revisar" ? 1 : -1)));
    }
    closeSheet();
    drawMovements();
    toast(t("saved"));
  } catch (e) {
    err.textContent = errText(e);
    err.hidden = false;
  } finally {
    delete form.dataset.busy;
    if (btn) btn.disabled = false;
  }
};
ACT.delMov = async (el) => {
  if (!el.classList.contains("armed")) {
    el.classList.add("armed");
    el.textContent = t("confirmDelete");
    return;
  }
  const id = Number(el.dataset.id);
  try {
    await api(`/movements/${id}`, { method: "DELETE" });
    S.list.items = S.list.items.filter((x) => x.id !== id);
    closeSheet();
    drawMovements();
    toast(t("deleted"));
  } catch (e) {
    toast(errText(e));
  }
};
