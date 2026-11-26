// Importar: upload a bank statement (PDF or CSV) any time, plus "Primeros pasos" steps 4 to 6
// (#/importar, #/pasos/ahorro, #/pasos/limites). The file is read on the phone by the readers in /import/,
// loaded with import() only here. Only rows go to the server; the file is never stored.
// Every text from a file goes through mask() (long digit runs keep their last 4) and esc().
import { S, app, VIEWS, ACT, hooks } from "../state.js";
import { t } from "../i18n.js";
import { esc, money, dateLabel, monthName, parseCents } from "../format.js";
import { api } from "../api.js";
import { activeAccounts, accById, topCats, setBadge } from "../data.js";
import { toast, errText, backBtn, pickCategory, movRow, tn } from "../ui.js";
import { paint } from "../motion.js";
import { catTile } from "../look.js";

// Memory only, never stored on the phone. A PDF password lives only inside one read call.
const st = { files: [], saved: [], recurring: null, review: [], list: null, busy: false, armed: null, badOk: false };
const pasos = { data: null, choice: Object.create(null) };

let mods = null; // the readers, loaded once on first use
let maskDigits = (s) => s;
function readers() {
  if (!mods) {
    mods = Promise.all([import("/import/read.js"), import("/import/parse.js"), import("/import/csv.js"), import("/import/upload.js")])
      .then(([read, parse, csv, upload]) => {
        maskDigits = parse.maskDigits;
        return { read, csv, upload };
      });
    mods.catch(() => (mods = null));
  }
  return mods;
}
const mask = (s) => maskDigits(String(s ?? ""));
function loadCss() {
  if (document.querySelector('link[href="/import/import.css"]')) return;
  const l = document.createElement("link");
  l.rel = "stylesheet";
  l.href = "/import/import.css";
  document.head.append(l);
}
// Fire and forget, but never an unhandled rejection; the server also counts a saved statement by itself (F53).
const step = (id, state) => {
  Promise.resolve().then(() => hooks.step?.(id, state)).catch(() => {});
};
const round5 = (c) => Math.max(0, Math.round(c / 500) * 500);

// ---------- #/importar ----------

// F52: each of these screens waits for the network before drawing; if another screen was opened meanwhile
// (S.nav moved on), that one owns the page and this late answer draws nothing.
VIEWS["/importar"] = async () => {
  const nav = S.nav;
  loadCss();
  const [, list] = await Promise.all([readers(), api("/imports").catch(() => null)]);
  if (S.nav !== nav) return;
  st.list = list;
  await paint(() => (app.innerHTML = importHtml()));
};
// Late results (a file still reading) redraw only while the import screen is the one shown.
const draw = () => {
  if (app.querySelector("#impFile")) app.innerHTML = importHtml();
};

function monthsText(period) {
  if (!period) return "";
  const a = monthName(period.start.slice(0, 7));
  const b = monthName(period.end.slice(0, 7));
  return a === b ? a : t("impMonths", { a, b });
}

function checkHtml(s) {
  const c = s.check;
  if (c.ok === true) return `<p class="imp-ok">${esc(t("impBalanced"))}</p>`;
  if (c.ok === null) return `<p class="imp-warn">${esc(t(c.label === "bad_lines" ? "impNoBalanceBad" : "impNoBalance"))}</p>`;
  let why;
  if (c.line) why = t("impBreakLine", { n: c.line });
  else if (c.expected == null) why = t("impBreakNoTotal");
  else if (c.parts && c.parts.total_line === false) why = t("impBreakTotal");
  else if (c.parts && c.parts.summary === false) why = t("impBreakSummary");
  else if (c.parts && c.parts.credits === false) why = t("impBreakCredits");
  else if (c.parts && c.parts.debits === false) why = t("impBreakDebits");
  else why = t("impBreakDiff");
  const nums = c.expected != null && c.got != null ? " " + t("impBreakNums", { x: money(c.expected), y: money(c.got), d: money(Math.abs(c.diff || 0)) }) : "";
  return `<p class="imp-bad">${esc(t("impNotBalanced"))} ${esc(why)}${esc(nums)}</p>`;
}

function csvMapHtml(f, i) {
  const cols = f.table.header.map((h, k) => ({ k, h: h || t("impCol", { n: k + 1 }) }));
  const sel = (key, allowNone) => `<label class="field"><span>${esc(t("impMap_" + key))}</span><select data-imp-map="${key}" data-i="${i}">
      ${allowNone ? `<option value="">${esc(t("impNone"))}</option>` : ""}
      ${cols.map((c) => `<option value="${c.k}" ${f.map[key] === c.k ? "selected" : ""}>${esc(mask(c.h))}</option>`).join("")}</select></label>`;
  const opts = (key, list) => list.map((o) => `<option value="${o}" ${f.map[key] === o ? "selected" : ""}>${esc(t(`imp_${key}_${o}`))}</option>`).join("");
  return `<details class="imp-map" ${f.mapOpen ? "open" : ""}><summary>${esc(t("impColumns"))}</summary>
    ${sel("fecha")}${sel("comercio", true)}${sel("monto", true)}${sel("cargo", true)}${sel("abono", true)}${sel("saldo", true)}
    <label class="field"><span>${esc(t("impMap_order"))}</span><select data-imp-map="order" data-i="${i}">${opts("order", ["dmy", "mdy", "ymd"])}</select></label>
    <label class="field"><span>${esc(t("impMap_sign"))}</span><select data-imp-map="sign" data-i="${i}">${opts("sign", ["out_negative", "out_positive"])}</select></label></details>`;
}

function fileHtml(f, i) {
  const head = `<h3>${esc(mask(f.name))}</h3>`;
  if (f.error === "password" || f.error === "bad_password") {
    return `<section class="imp-file">${head}<form data-submit="impPass" data-i="${i}">
      <label class="field"><span>${esc(t(f.error === "password" ? "impNeedPass" : "impBadPass"))}</span>
      <input name="p" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" required></label>
      <div class="btns"><button class="btn primary">${esc(t("impOpen"))}</button></div></form></section>`;
  }
  const errKey = "impErr_" + f.error;
  const err = f.error ? `<p class="imp-bad">${esc(t(errKey) === errKey ? errText({ code: f.error }) : t(errKey))}</p>` : "";
  if (f.reading) return `<section class="imp-file">${head}<p class="muted">${esc(t("impReading"))}</p></section>`;
  if (f.error && !(f.error === "no_rows" && f.table)) return `<section class="imp-file">${head}${err}</section>`;
  const s = f.statement;
  if (!s) return `<section class="imp-file">${head}${err}${f.table ? csvMapHtml(f, i) : ""}</section>`;
  const n = s.rows.length;
  const found = n ? t(n === 1 ? "impFound1" : "impFoundN", { n, m: monthsText(s.period) }) : "";
  const counts = f.undone ? `<p class="imp-counts">${esc(t("impUndone"))}</p>`
    : f.done ? `<p class="imp-ok">${esc(t("impSaved", { a: tn("impNew", f.done.added), b: tn("impAlready", f.done.already), c: tn("impJoined", f.done.merged) }))}</p>`
    : f.preview ? `<p class="imp-counts">${esc(t("impPreview", { a: tn("impNew", f.preview.added), b: tn("impAlready", f.preview.already), c: tn("impJoins", f.preview.merged) }))}${f.preview.review ? " " + esc(tn("impPreviewReview", f.preview.review)) : ""}</p>`
    : f.previewing ? `<p class="muted">${esc(t("impChecking"))}</p>` : "";
  const rows = s.rows.slice(0, 30).map((r) => `<div class="row"><div class="grow"><span class="title">${esc(mask(r.comercio) || "—")}</span>
      <span class="sub">${esc(dateLabel(r.fecha))}${r.tipo === "interno" ? " · " + esc(t("tipo_interno")) : ""}</span></div>
      <span class="amt">${esc(money(-r.cents, true))}</span></div>`).join("");
  const accs = activeAccounts().map((a) => `<option value="${a.id}" ${a.id === f.accountId ? "selected" : ""}>${esc(a.name)}</option>`).join("");
  // F02: lines the reader could not read are named, so a missing purchase is never silent.
  const bad = s.bad && s.bad.length && !f.done
    ? `<p class="imp-bad">${esc(t(s.bad.length === 1 ? "impBadLines1" : "impBadLinesN", { n: s.bad.length, lines: s.bad.slice(0, 12).join(", ") + (s.bad.length > 12 ? "…" : "") }))}</p>` : "";
  return `<section class="imp-file">${head}
    ${found ? `<p class="imp-found">${esc(found)}</p>${checkHtml(s)}` : ""}${bad}${err}
    ${f.table && !f.done ? csvMapHtml(f, i) : ""}
    ${f.done || !n ? "" : `<label class="field"><span>${esc(t("impAccount"))}</span><select data-imp-acc data-i="${i}">
      <option value="">${esc(t("impPickAccount"))}</option>${accs}</select></label>`}
    ${counts}
    ${n ? `<details class="imp-rows"><summary>${esc(t("impSeeRows", { n: Math.min(n, 30) }))}</summary><div class="list">${rows}</div></details>` : ""}
  </section>`;
}

function afterHtml() {
  if (!st.saved.length) return "";
  const rec = st.recurring;
  const recHtml = !rec ? `<p class="muted">${esc(t("impChecking"))}</p>` : !rec.length ? `<p class="muted">${esc(t("impNoFixed"))}</p>`
    : `<div class="list">${rec.map((r) => `<div class="row imp-rec"><div class="grow"><span class="title">${esc(mask(r.comercio))}</span>
        <span class="sub">${esc(money(r.amount_cents))} · ${esc(t("impEvery" + r.every_days))}</span></div>
        <div class="seg"><button data-act="impKeep" data-key="${esc(r.merchant_key)}" data-v="1" aria-pressed="${r.keep !== false}">${esc(t("impKeep"))}</button>
        <button data-act="impKeep" data-key="${esc(r.merchant_key)}" data-v="0" aria-pressed="${r.keep === false}">${esc(t("impRemove"))}</button></div></div>`).join("")}</div>`;
  const top = topCats(6);
  const rv = st.review.length
    ? st.review.map((m) => `<section class="rv"><div class="list">${movRow(m)}</div><p class="meta">${esc(dateLabel(m.fecha))}</p>
        <div class="chips">${top.map((c) => `<button class="chip" data-act="impCat" data-id="${m.id}" data-cat="${c.id}">${catTile(c.id, "sm")}${esc(c.name)}</button>`).join("")}
        <button class="chip more" data-act="impOther" data-id="${m.id}">${esc(t("other"))}</button></div></section>`).join("")
    : `<p class="muted">${esc(t("impReviewNone"))}</p>`;
  return `<h2>${esc(t("impFixedTitle"))}</h2><p class="note">${esc(t("impFixedHint"))}</p>${recHtml}
    <h2>${esc(t("impReviewTitle"))}</h2><p class="note">${esc(t("impReviewHint"))}</p>${rv}
    <div class="btns"><a class="btn primary" href="#/pasos/ahorro">${esc(t("impNextSavings"))}</a></div>`;
}

function historyHtml() {
  const items = (st.list && st.list.items) || [];
  if (!items.length) return "";
  const short = { day: "numeric", month: "short" };
  const rows = items.slice(0, 20).map((im) => {
    const acc = accById(im.account_id);
    const period = t("impMonths", { a: dateLabel(im.period_start, short), b: dateLabel(im.period_end, { ...short, year: "numeric" }) });
    const side = im.status === "undone" ? `<span class="muted small">${esc(t("impUndone"))}</span>`
      : `<button class="btn ${st.armed === im.id ? "danger armed" : ""}" data-act="impUndo" data-id="${im.id}">${esc(t(st.armed === im.id ? "impUndoSure" : "impUndo"))}</button>`;
    return `<div class="row"><div class="grow"><span class="title">${esc(acc ? acc.name : "?")}</span>
      <span class="sub">${esc(period)} · ${esc(t("impListCounts", { a: tn("impNew", im.added), b: tn("impAlready", im.already) }))}</span></div><div class="side">${side}</div></div>`;
  }).join("");
  const cover = (st.list.coverage || []).map((c) => {
    const acc = accById(c.account_id);
    return `<p class="note">${esc(acc ? acc.name : "?")}: ${esc(c.months.map(monthName).join(", "))}</p>`;
  }).join("");
  return `<h2>${esc(t("impHistory"))}</h2>${cover ? `<p class="small">${esc(t("impCovered"))}</p>${cover}` : ""}
    <div class="list grouped plain imp-hist">${rows}</div>`;
}

function importHtml() {
  const ready = st.files.filter((f) => f.statement && f.statement.rows.length && !f.done && !f.error);
  const canSave = ready.length && ready.every((f) => f.accountId && f.preview) && !st.busy;
  const unbalanced = ready.some((f) => f.statement.check.ok === false);
  const hasBad = ready.some((f) => f.statement.bad && f.statement.bad.length);
  const label = st.busy ? "impSaving" : hasBad ? (st.badOk ? "impSaveWithoutSure" : "impSaveWithout") : unbalanced ? "impSaveAnyway" : "impSave";
  return `${backBtn(["/mas", "/"])}<h1>${esc(t("impTitle"))}</h1>
    <p class="note">${esc(t("impIntro"))}</p>
    <label class="btn block imp-pick">${esc(t(st.files.length ? "impPickMore" : "impPick"))}
      <input id="impFile" type="file" accept=".pdf,.csv,application/pdf,text/csv" multiple></label>
    ${st.files.map(fileHtml).join("")}
    ${ready.length ? `<div class="btns"><button class="btn primary${hasBad && st.badOk ? " armed" : ""}" data-act="impSave" ${canSave ? "" : "disabled"}>${esc(t(label))}</button></div>` : ""}
    ${afterHtml()}${historyHtml()}`;
}

function guessAccount(s) {
  const accs = activeAccounts();
  if (s.card) {
    const a = accs.find((x) => x.name.endsWith(s.card));
    if (a) return a.id;
  }
  if (s.kind === "uglycash") {
    const a = accs.find((x) => /ugly/i.test(x.name));
    if (a) return a.id;
  }
  return null;
}

async function preview(f) {
  const ticket = (f.ticket = (f.ticket || 0) + 1); // F56: only the newest preview may write its answer
  const m = await readers();
  const s = f.statement;
  if (ticket !== f.ticket) return;
  f.preview = null;
  if (!f.accountId || !s || !s.rows.length || !s.period) return draw();
  f.previewing = true;
  draw();
  const sum = { added: 0, already: 0, merged: 0, review: 0 };
  try {
    for (const rows of m.upload.chunkRows(m.upload.apiRows(s))) {
      const p = await api("/imports/preview", { method: "POST", body: { account_id: f.accountId, source: s.kind, period_start: s.period.start, period_end: s.period.end, rows } });
      if (ticket !== f.ticket) return;
      for (const k of Object.keys(sum)) sum[k] += p[k];
    }
    f.preview = sum;
  } catch (e) {
    if (ticket !== f.ticket) return;
    toast(errText(e));
  }
  f.previewing = false;
  draw();
}

async function readOne(f, password) {
  f.reading = true;
  f.error = null;
  draw();
  try {
    const m = await readers();
    if (/\.csv$/i.test(f.name) || f.file.type === "text/csv") {
      f.table = await m.read.readCsvFile(f.file);
      f.sig = await m.read.headerSig(m.csv.headerText(f.table.header));
      f.map = m.csv.guessMap(f.table.header, f.table.rows);
      const saved = await api(`/imports/csv-maps/${f.sig}`).catch(() => null);
      if (saved && saved.map) {
        f.map = { ...f.map, ...saved.map };
        if (saved.account_id && accById(saved.account_id)) f.accountId = saved.account_id;
      }
      f.statement = m.csv.readCsv(f.table, f.map);
    } else {
      f.statement = await m.read.readPdf(f.file, password);
      f.accountId = f.accountId || guessAccount(f.statement);
    }
    if (!f.statement.rows.length) f.error = "no_rows";
  } catch (e) {
    f.error = (e && e.code) || "bad_file";
  }
  f.reading = false;
  if (f.error) draw();
  else await preview(f);
}

// The file input and the selects change outside data-act, so listen once here.
document.addEventListener("change", (e) => {
  const el = e.target;
  if (!(el instanceof HTMLElement) || !app.contains(el)) return;
  if (el.id === "impFile") {
    const picked = [...el.files].slice(0, 6);
    el.value = "";
    st.badOk = false; // a new file may bring its own unreadable lines: ask again
    for (const file of picked) {
      const f = { name: file.name, file, statement: null, accountId: null };
      st.files.push(f);
      readOne(f);
    }
    return;
  }
  const f = st.files[Number(el.dataset.i)];
  if (!f) return;
  if (el.matches("[data-imp-acc]")) {
    f.accountId = Number(el.value) || null;
    f.importId = null; // a new account or new columns are a new import; a half-saved one stays in the history
    st.badOk = false;
    preview(f);
  } else if (el.matches("[data-imp-map]")) {
    const key = el.dataset.impMap;
    f.map[key] = key === "order" || key === "sign" ? el.value : el.value === "" ? null : Number(el.value);
    if (key === "monto" && f.map.monto != null) f.map.cargo = f.map.abono = null;
    if ((key === "cargo" || key === "abono") && f.map[key] != null) f.map.monto = null;
    f.mapOpen = true;
    f.importId = null;
    st.badOk = false;
    readers().then((m) => {
      f.statement = m.csv.readCsv(f.table, f.map);
      f.error = f.statement.rows.length ? null : "no_rows";
      if (f.error) draw();
      else preview(f);
    });
  }
});

ACT.impPass = (form) => {
  const f = st.files[Number(form.dataset.i)];
  const p = form.elements.p.value;
  form.reset();
  if (f) readOne(f, p);
};

ACT.impSave = async () => {
  if (st.busy) return;
  const todo = st.files.filter((x) => x.statement && x.statement.rows.length && !x.done && !x.error && x.accountId);
  // F02: lines that could not be read are left out only after a second tap on "Guardar sin esas líneas".
  if (!st.badOk && todo.some((f) => f.statement.bad && f.statement.bad.length)) {
    st.badOk = true;
    return draw();
  }
  const m = await readers();
  st.busy = true;
  draw();
  let ok = 0;
  for (const f of todo) {
    const s = f.statement;
    try {
      // F20: a failed save is tried again on the SAME import: parts it already saved come back as duplicates.
      if (!f.importId) {
        f.importId = (await api("/imports", {
          method: "POST",
          body: { account_id: f.accountId, source: s.kind, period_start: s.period.start, period_end: s.period.end, balanced: s.check.ok === true },
        })).id;
      }
      const id = f.importId;
      for (const [part, rows] of m.upload.chunkRows(m.upload.apiRows(s)).entries()) await api(`/imports/${id}/rows`, { method: "POST", body: { part, rows } });
      const r = await api(`/imports/${id}/finish`, { method: "POST" });
      if (f.table && f.sig && f.map.fecha != null) api(`/imports/csv-maps/${f.sig}`, { method: "PUT", body: { account_id: f.accountId, map: f.map } }).catch(() => {});
      f.done = r.totals;
      f.file = null; // nothing of the file is kept once its rows are saved
      f.table = null;
      st.saved.push(id);
      ok++;
    } catch (e) {
      toast(errText(e));
    }
  }
  st.busy = false;
  st.badOk = false;
  if (ok) {
    step("statements", "done");
    const boot = await api("/bootstrap").catch(() => null); // counts and the review badge changed
    if (boot) {
      S.boot = boot;
      setBadge(boot.review_count);
    }
    await loadAfter();
  }
  draw();
};

async function loadAfter() {
  try {
    const [rec, list, ...reviews] = await Promise.all([api("/imports/recurring"), api("/imports"), ...st.saved.map((id) => api(`/imports/${id}/review`))]);
    st.recurring = rec.items;
    st.list = list;
    const seen = new Set();
    st.review = reviews.flatMap((r) => r.items).filter((x) => !seen.has(x.id) && seen.add(x.id))
      .sort((a, b) => b.fecha.localeCompare(a.fecha) || b.id - a.id).slice(0, 10);
  } catch (e) {
    toast(errText(e));
  }
}

ACT.impKeep = async (el) => {
  const keep = el.dataset.v === "1";
  try {
    await api("/imports/recurring", { method: "POST", body: { merchant_key: el.dataset.key, keep } });
    const r = (st.recurring || []).find((x) => x.merchant_key === el.dataset.key);
    if (r) r.keep = keep;
    draw();
  } catch (e) {
    toast(errText(e));
  }
};

async function categorize(id, catId) {
  try {
    const r = await api(`/review/${id}/categorize`, { method: "POST", body: { category_id: catId, apply_same: true } });
    toast(r.also_updated ? t("alsoUpdated", { n: r.also_updated }) : t("done"));
    st.review = st.review.filter((m) => m.id !== Number(id));
    draw();
  } catch (e) {
    toast(errText(e));
  }
}
ACT.impCat = (el) => categorize(el.dataset.id, Number(el.dataset.cat));
ACT.impOther = async (el) => {
  const id = await pickCategory(null);
  if (id) categorize(el.dataset.id, id);
};

ACT.impUndo = async (el) => {
  const id = Number(el.dataset.id);
  if (st.armed !== id) {
    st.armed = id;
    return draw();
  }
  st.armed = null;
  try {
    const r = await api(`/imports/${id}/undo`, { method: "POST" });
    toast(r.kept ? t("impUndoneKept", { n: r.removed, k: r.kept }) : t("impUndoneN", { n: r.removed }));
    // A saved file shows "Deshecho"; a half-saved one (its save failed) starts a new import on the next Guardar.
    for (const f of st.files) {
      if (f.importId !== id) continue;
      if (f.done) f.undone = true;
      else f.importId = null;
    }
    if (st.saved.includes(id)) {
      st.saved = st.saved.filter((x) => x !== id);
      st.review = [];
      if (st.saved.length) await loadAfter();
    }
    st.list = await api("/imports");
    S.boot = await api("/bootstrap");
    setBadge(S.boot.review_count);
  } catch (e) {
    toast(errText(e));
  }
  draw();
};

// ---------- #/pasos/ahorro (step 5): an optional savings amount, never a group limit ----------

function overIncome(limits, savings) {
  const inc = pasos.data && pasos.data.income_avg_cents;
  if (inc == null || limits + savings <= inc) return "";
  return `<p class="imp-warn">${esc(t("pasosOver", { x: money(limits + savings), y: money(inc) }))}</p>`;
}

VIEWS["/pasos/ahorro"] = async () => {
  const nav = S.nav;
  loadCss();
  const data = await api("/pasos");
  if (S.nav !== nav) return; // F52
  pasos.data = data;
  const d = pasos.data;
  const val = d.savings_cents != null ? (d.savings_cents / 100).toFixed(2) : "";
  await paint(() => (app.innerHTML = `${backBtn(["/", "/mas"])}<h1>${esc(t("pasosSavingsTitle"))}</h1>
    <p class="note">${esc(t("pasosSavingsHint"))}</p>
    <form data-submit="pasosSavings">
      <label class="field"><span>${esc(t("pasosSavingsField"))}</span><input id="savAmt" name="amount" inputmode="decimal" autocomplete="off" value="${esc(val)}" placeholder="0.00"></label>
      <div id="savWarn">${overIncome(d.limits_sum_cents, d.savings_cents || 0)}</div>
      <p class="err" hidden></p>
      <div class="btns"><button class="btn primary">${esc(t("save"))}</button><a class="btn" href="#/pasos/limites">${esc(t("pasosSkip"))}</a></div>
    </form>`));
};

document.addEventListener("input", (e) => {
  const el = e.target;
  if (!(el instanceof HTMLInputElement) || !pasos.data) return;
  if (el.id === "savAmt") {
    const w = document.getElementById("savWarn");
    if (w) w.innerHTML = overIncome(pasos.data.limits_sum_cents, parseCents(el.value) || 0);
  } else if (el.matches("[data-lim-own]")) {
    const c = parseCents(el.value);
    pasos.choice[el.dataset.g] = { mode: "own", cents: c == null || c < 0 ? null : round5(c) };
    const w = document.getElementById("limWarn");
    if (w) w.innerHTML = limitsWarn();
    const g = pasos.data.groups.find((x) => String(x.id) === el.dataset.g);
    const will = app.querySelector(`[data-will="${Number(el.dataset.g)}"]`);
    if (g && will) will.innerHTML = willText(g);
    const btn = app.querySelector('[data-act="limSave"]');
    if (btn) btn.disabled = !canSaveLimits();
  }
});

ACT.pasosSavings = async (form) => {
  const err = form.querySelector(".err");
  const v = form.elements.amount.value.trim();
  const cents = v === "" ? 0 : parseCents(v);
  if (cents == null || cents < 0) {
    err.textContent = t("invalidAmount");
    err.hidden = false;
    return;
  }
  try {
    await api("/pasos/savings", { method: "PUT", body: { amount_cents: cents } });
    step("savings", "done");
    toast(t("saved"));
    location.hash = "#/pasos/limites";
  } catch (e) {
    err.textContent = errText(e);
    err.hidden = false;
  }
};

// ---------- #/pasos/limites (step 6): limits from full months of spending ----------

function chosenCents(g) {
  const c = pasos.choice[g.id];
  if (!c) return g.limit_cents;
  if (c.mode === "own") return c.cents;
  const a = g.avg_cents || 0;
  return round5(c.mode === "same" ? a : c.mode === "less10" ? a * 0.9 : a * 0.8);
}
function willText(g) {
  const cents = chosenCents(g);
  return cents == null ? "" : esc(t("pasosWillBe", { x: money(cents) }));
}
const canSaveLimits = () => pasos.data.groups.some((g) => pasos.choice[g.id] && chosenCents(g) != null);
function limitsWarn() {
  const d = pasos.data;
  return overIncome(d.groups.reduce((s, g) => s + (chosenCents(g) || 0), 0), d.savings_cents || 0);
}

function limitsHtml() {
  const d = pasos.data;
  const body = d.groups.map((g) => {
    const c = pasos.choice[g.id];
    const opt = (mode, label) => `<button type="button" data-act="limPick" data-g="${g.id}" data-mode="${mode}" aria-pressed="${!!c && c.mode === mode}">${esc(label)}</button>`;
    const now = g.limit_cents != null ? " " + t("pasosNow", { x: money(g.limit_cents) }) : "";
    return `<section class="imp-lim"><h3>${esc(g.name)}</h3>
      <p class="note">${esc(g.avg_cents != null ? t("pasosAvg", { x: money(g.avg_cents) }) : t("pasosNoMonth"))}${esc(now)}</p>
      <div class="seg">${g.avg_cents != null ? opt("same", t("pasosSame")) + opt("less10", "−10%") + opt("less20", "−20%") : ""}${opt("own", t("pasosOwn"))}</div>
      ${c && c.mode === "own" ? `<label class="field"><span>${esc(t("pasosOwnField"))}</span><input data-lim-own data-g="${g.id}" inputmode="decimal" autocomplete="off" value="${c.cents != null ? esc((c.cents / 100).toFixed(2)) : ""}"></label>` : ""}
      ${c ? `<p class="small imp-will" data-will="${g.id}">${willText(g)}</p>` : ""}
    </section>`;
  }).join("");
  return `${backBtn(["/", "/mas"])}<h1>${esc(t("pasosLimitsTitle"))}</h1>
    <p class="note">${esc(d.months.length ? t("pasosLimitsHint", { n: d.months.length }) : t("pasosLimitsNoData"))}</p>
    ${body}<div id="limWarn">${limitsWarn()}</div>
    <div class="btns"><button class="btn primary" data-act="limSave" ${canSaveLimits() ? "" : "disabled"}>${esc(t("save"))}</button>
      <button class="btn" data-act="limWait">${esc(t("pasosWait"))}</button></div>`;
}

VIEWS["/pasos/limites"] = async () => {
  const nav = S.nav;
  loadCss();
  const data = await api("/pasos");
  if (S.nav !== nav) return; // F52
  pasos.data = data;
  pasos.choice = Object.create(null);
  await paint(() => (app.innerHTML = limitsHtml()));
};

ACT.limPick = (el) => {
  const g = Number(el.dataset.g);
  pasos.choice[g] = { mode: el.dataset.mode, cents: null };
  app.innerHTML = limitsHtml();
  if (el.dataset.mode === "own") app.querySelector(`[data-lim-own][data-g="${g}"]`)?.focus();
};

ACT.limSave = async (el) => {
  el.disabled = true;
  try {
    for (const g of pasos.data.groups) {
      const cents = pasos.choice[g.id] ? chosenCents(g) : null;
      if (cents != null) await api(`/groups/${g.id}`, { method: "PUT", body: { limit_cents: cents } });
    }
    step("limits", "done");
    toast(t("pasosLimitsSaved"));
    S.boot = null;
    location.hash = "#/";
  } catch (e) {
    el.disabled = false;
    toast(errText(e));
  }
};

ACT.limWait = () => {
  step("limits", "waiting");
  toast(t("pasosWaitToast"));
  location.hash = "#/";
};
