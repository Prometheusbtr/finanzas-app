// Análisis: where the money went in a week, a month or a year. Read only: it pages GET /api/movements.
// Spending counts the same way as /api/summary: every gasto minus every abono, in any category.
// Tapping a bar, a group or a shop opens those movements in Movimientos through its usual hash filters.
import { S, app, VIEWS, ACT, PARTS } from "../state.js";
import { t, locale } from "../i18n.js";
import { esc, money, dateLabel, monthName, capFirst, shiftMonth } from "../format.js";
import { catById, groupById, spendPart, showCached } from "../data.js";
import { tile, groupLook } from "../look.js";
import { tn, tHtml } from "../ui.js";
import { barsWithAverage, stackedBar, dataTable } from "../charts.js";
import { paint, navAs, play, riseIn, countUp, reduced, DUR, EASE_SHEET } from "../motion.js";

// Each month's gastos and abonos live in the shared screen memory (js/data.js), one entry per month, the same
// entry Home uses: a period shows at once when its months were seen, and fresh numbers load behind it.
let charts = [];
let cur = null; // the period on screen
let shownTotal = 0; // the big number on screen, so the next period counts from it
let segGlide = null; // { from, to, t0 } of a Semana/Mes/Año tap, so the redrawn control finishes the same glide

// The segmented control's white thumb sits under segment N (class at-N, CSS does the math, no measuring).
// A tap glides it there at once, before the new numbers load (transform only).
const thumbAt = (n) => ({ transform: `translateX(calc(${n} * (100% + 3px)))` });
function glideThumb(thumb, from, to, elapsed = 0) {
  if (!thumb || from === to || reduced()) return;
  const a = play(thumb, [thumbAt(from), thumbAt(to)], { duration: DUR.mid, easing: EASE_SHEET });
  if (a && elapsed > 0) a.currentTime = Math.min(elapsed, DUR.mid);
}
/** After each paint: finish a period glide, let the content rise in on a period change, count the total. */
function afterPaint(total, quiet) {
  const glide = quiet ? null : segGlide;
  if (!quiet) segGlide = null;
  if (glide) {
    glideThumb(app.querySelector(".seg-thumb"), glide.from, glide.to, performance.now() - glide.t0);
    riseIn(app.querySelectorAll('[data-screen="analisis"] > :not(h1):not(.seg)'), 6);
  }
  countUp(document.getElementById("anHero"), shownTotal, total, money);
  shownTotal = total;
}

// ---------- dates (all UTC, on "YYYY-MM-DD" strings) ----------
const pad = (n) => String(n).padStart(2, "0");
const D = (s) => new Date(s + "T00:00:00Z");
const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (s, n) => {
  const d = D(s);
  d.setUTCDate(d.getUTCDate() + n);
  return iso(d);
};
const weekday = (s) => (D(s).getUTCDay() + 6) % 7; // 0 = Monday
// Semana starts on her week's first day (Ajustes → Tu presupuesto); Monday when she never chose one
const weekStartOf = (s) => {
  const ws = (S.boot && S.boot.budget && S.boot.budget.week_start) ?? 1;
  return addDays(s, -((D(s).getUTCDay() - ws + 7) % 7));
};
const daysBetween = (a, b) => Math.round((D(b) - D(a)) / 86400000) + 1; // both ends count
const lastDayOf = (ym) => {
  const [y, m] = ym.split("-").map(Number);
  return iso(new Date(Date.UTC(y, m, 0)));
};
const MONDAY = Date.UTC(2024, 0, 1); // a Monday, to name the weekdays
const weekdayName = (i, style) => new Intl.DateTimeFormat(locale(), { timeZone: "UTC", weekday: style }).format(new Date(MONDAY + i * 86400000));
const monthShort = (ym) => {
  const [y, m] = ym.split("-").map(Number);
  return new Intl.DateTimeFormat(locale(), { timeZone: "UTC", month: "short" }).format(new Date(Date.UTC(y, m - 1, 1))).replace(".", "");
};
const longDay = (d) => capFirst(dateLabel(d, { weekday: "long", day: "numeric", month: "long" }));
const spentOf = (m) => (m.tipo === "gasto" ? m.amount_cents : m.tipo === "abono" ? -m.amount_cents : 0);
const qs = (o) => new URLSearchParams(o).toString();

// `at` comes from the address bar, so only real dates from 2000 on (the server's first allowed day) count.
const MIN_DAY = "2000-01-01";
const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || "") && s >= MIN_DAY && !Number.isNaN(D(s).getTime()) && iso(D(s)) === s;
const isMonth = (s) => /^\d{4}-(0[1-9]|1[0-2])$/.test(s || "") && s >= MIN_DAY.slice(0, 7);
const isYear = (s) => /^\d{4}$/.test(s || "") && s >= MIN_DAY.slice(0, 4);

/** The period to show: kind semana | mes | anio, anchored at `at`, never past today. */
function period(kind, at, today) {
  const curMonth = today.slice(0, 7);
  if (kind === "semana") {
    const start = weekStartOf(isDay(at) && at <= today ? at : today);
    const end = addDays(start, 6);
    const slots = [];
    for (let i = 0; i < 7; i++) {
      const d = addDays(start, i);
      slots.push({ from: d, to: d, short: weekdayName(weekday(d), "short").replace(".", ""), label: longDay(d) });
    }
    const dm = { day: "numeric", month: "short" };
    return {
      kind, start, end, slots, unit: "day",
      label: `${dateLabel(start, dm)} – ${dateLabel(end, dm)}`,
      prev: addDays(start, -7), next: addDays(start, 7) <= today ? addDays(start, 7) : null,
    };
  }
  if (kind === "anio") {
    const y = isYear(at) && at <= today.slice(0, 4) ? at : today.slice(0, 4);
    const slots = [];
    for (let m = 1; m <= 12; m++) {
      const ym = `${y}-${pad(m)}`;
      slots.push({ from: `${ym}-01`, to: lastDayOf(ym), ym, short: monthShort(ym), label: `${capFirst(monthName(ym))} ${y}` });
    }
    return {
      kind, start: `${y}-01-01`, end: `${y}-12-31`, slots, unit: "month", label: y,
      prev: String(Number(y) - 1), next: Number(y) + 1 <= Number(today.slice(0, 4)) ? String(Number(y) + 1) : null,
    };
  }
  const ym = isMonth(at) && at <= curMonth ? at : curMonth;
  const end = lastDayOf(ym);
  const slots = [];
  for (let d = `${ym}-01`; d <= end; d = addDays(d, 1)) slots.push({ from: d, to: d, short: String(Number(d.slice(8))), label: longDay(d) });
  return {
    kind: "mes", start: `${ym}-01`, end, slots, unit: "day",
    label: `${capFirst(monthName(ym))} ${ym.slice(0, 4)}`,
    prev: shiftMonth(ym, -1), next: shiftMonth(ym, 1) <= curMonth ? shiftMonth(ym, 1) : null,
  };
}

/** The memory entries a period needs: one per month from its first day to `last`. */
function monthParts(p, last) {
  const parts = [];
  for (let ym = p.start.slice(0, 7); ym <= last.slice(0, 7); ym = shiftMonth(ym, 1)) parts.push(spendPart(ym));
  return parts;
}
const kindOf = (params) => (["semana", "mes", "anio"].includes(params.get("p")) ? params.get("p") : "mes");
const lastOf = (p, today) => (p.end < today ? p.end : today);
PARTS["/analisis"] = (params) => {
  const today = S.boot.today;
  const p = period(kindOf(params), params.get("at"), today);
  return monthParts(p, lastOf(p, today));
};

function groupOf(m) {
  const c = m.category_id ? catById(m.category_id) : null;
  const g = c ? groupById(c.group_id) : null;
  return g || null;
}

/** All the numbers for one period. */
function crunch(p, items, today) {
  const last = p.end < today ? p.end : today;
  // A year may start before the data does: count from the first month that has any spending.
  let first = p.start;
  if (p.kind === "anio" && items.length) first = items.reduce((a, m) => (m.fecha < a ? m.fecha : a), "9999").slice(0, 7) + "-01";
  const nDays = Math.max(1, daysBetween(first, last));
  const total = items.reduce((a, m) => a + spentOf(m), 0);

  const bySlot = new Map();
  for (const m of items) {
    const k = p.unit === "day" ? m.fecha : m.fecha.slice(0, 7);
    bySlot.set(k, (bySlot.get(k) || 0) + spentOf(m));
  }
  const values = p.slots.map((s) => (s.from > last || s.to < first ? null : bySlot.get(p.unit === "day" ? s.from : s.ym) || 0));
  let avg = total / nDays;
  if (p.unit === "month") {
    const done = p.slots.map((s, i) => (values[i] != null && s.to < today ? values[i] : null)).filter((v) => v != null);
    const any = values.filter((v) => v != null);
    const pool = done.length ? done : any;
    avg = pool.length ? pool.reduce((a, b) => a + b, 0) / pool.length : 0;
  }

  const groups = new Map(); // group id (0 = no category) -> { value, n }
  const kinds = { E: 0, G: 0, A: 0, M: 0 };
  const shops = new Map();
  const wdTotal = new Array(7).fill(0);
  for (const m of items) {
    const v = spentOf(m);
    const g = groupOf(m);
    const gid = g ? g.id : 0;
    const e = groups.get(gid) || { group: g, value: 0, n: 0 };
    e.value += v;
    if (m.tipo === "gasto") e.n++;
    groups.set(gid, e);
    const c = m.category_id ? catById(m.category_id) : null;
    if (c && kinds[c.kind] != null) kinds[c.kind] += v;
    wdTotal[weekday(m.fecha)] += v;
    const name = String(m.comercio || "").trim();
    if (name) {
      const key = name.toUpperCase().replace(/\s+/g, " ");
      const s = shops.get(key) || { name, value: 0, n: 0, amounts: new Set(), byGroup: new Map() };
      s.value += v;
      if (m.tipo === "gasto") {
        s.n++;
        s.amounts.add(m.amount_cents);
      }
      s.byGroup.set(gid, (s.byGroup.get(gid) || 0) + v);
      shops.set(key, s);
    }
  }
  const wdDays = new Array(7).fill(0);
  for (let d = first; d <= last; d = addDays(d, 1)) wdDays[weekday(d)]++;
  const wdAvg = wdTotal.map((v, i) => (wdDays[i] ? v / wdDays[i] : null));
  const shopList = [...shops.values()].map((s) => {
    let best = 0, bestV = -Infinity;
    for (const [gid, v] of s.byGroup) if (v > bestV) [best, bestV] = [gid, v];
    return { ...s, group: best ? groupById(best) : null };
  });
  return {
    last, first, nDays, total, values, avg, kinds, wdAvg, wdTotal,
    groups: [...groups.entries()].map(([id, e]) => ({ id, ...e })).filter((g) => g.value > 0).sort((a, b) => b.value - a.value),
    top: shopList.filter((s) => s.value > 0).sort((a, b) => b.value - a.value).slice(0, 5),
    repeats: shopList.filter((s) => s.n >= 2 && s.value > 0).sort((a, b) => b.n - a.n || b.value - a.value).slice(0, 5),
  };
}

const look = (g) => (g ? groupLook(g.name) : ["question-mark", "gray"]);
const gname = (g) => (g ? g.name : t("uncategorized"));

function shopRow(s, sub, linkMonth) {
  const [ic, color] = look(s.group);
  const href = "#/movimientos?" + qs({ month: linkMonth, q: s.name.slice(0, 80), tipo: "gastos" });
  return `<a class="row" href="${esc(href)}">${tile(ic, color)}
    <span class="grow"><span class="title">${esc(s.name)}</span><span class="sub">${esc(sub)}</span></span>
    <span class="amt">${money(s.value)}</span></a>`;
}

VIEWS["/analisis"] = (params) => {
  if (!app.querySelector('[data-screen="analisis"]')) segGlide = null; // a glide left over from before the tab was left has nothing to finish
  const today = S.boot.today;
  const kind = kindOf(params);
  const p = period(kind, params.get("at"), today);
  cur = p;
  const last = lastOf(p, today);
  return showCached(monthParts(p, last), (lists, quiet) =>
    draw(p, kind, today, lists.flat().filter((m) => m.fecha >= p.start && m.fecha <= last), quiet));
};

/** Draw one period. quiet: a background redraw with fresher numbers (no intro motion). */
async function draw(p, kind, today, items, quiet) {
  charts.forEach((c) => c.destroy());
  charts = [];
  const c = crunch(p, items, today);
  // Movimientos has a month filter, not a date range: a year opens all months, a week the month it ends in.
  const linkMonth = p.kind === "anio" ? "" : c.last.slice(0, 7);
  const kinds = [["semana", t("week")], ["mes", t("month")], ["anio", t("year")]];
  const seg = kinds
    .map(([v, label]) => `<button data-act="anPeriod" data-v="${v}" aria-pressed="${v === kind}">${esc(label)}</button>`).join("");
  const at = kinds.findIndex(([v]) => v === kind);
  const head = `<h1>${esc(t("analysis"))}</h1>
    <div class="seg has-thumb" role="group" aria-label="${esc(t("period"))}"><i class="seg-thumb at-${at}" aria-hidden="true"></i>${seg}</div>
    <div class="stepper">
      <button class="iconbtn" data-act="anStep" data-n="-1" aria-label="${esc(t("prevPeriod"))}"><svg class="ico" aria-hidden="true" focusable="false"><use href="/icons.svg#i-chevron-left"></use></svg></button>
      <div class="label num" aria-live="polite">${esc(p.label)}</div>
      <button class="iconbtn" data-act="anStep" data-n="1" aria-label="${esc(t("nextPeriod"))}" ${p.next ? "" : "disabled"}><svg class="ico" aria-hidden="true" focusable="false"><use href="/icons.svg#i-chevron-right"></use></svg></button>
    </div>
    <section class="an-sum">
      <p class="eyebrow">${esc(t("spentPeriod"))}</p>
      <p class="hero num"><span class="sr">${money(c.total)}</span><span id="anHero" aria-hidden="true">${money(c.total)}</span></p>
      ${items.length ? `<p class="perday">${tHtml("perDayFig", { x: `<strong>${money(Math.round(c.total / c.nDays))}</strong>` })} · ${esc(t("perDayOver", { n: tn("days", c.nDays) }))}</p>` : ""}
      ${p.kind === "anio" && items.length && c.first > p.start ? `<p class="note">${esc(t("dataFrom", { m: `${monthName(c.first.slice(0, 7))} ${c.first.slice(0, 4)}` }))}</p>` : ""}
    </section>`;
  if (!items.length) {
    await paint(() => (app.innerHTML = `<div data-screen="analisis">${head}<p class="empty">${esc(t("noSpendPeriod"))}</p></div>`));
    afterPaint(c.total, quiet);
    return;
  }

  // groups: the five biggest get their own block, the rest fold into "Otros"
  const topG = c.groups.slice(0, 5);
  const rest = c.groups.slice(5).reduce((a, g) => a + g.value, 0);
  // Each top group's block wears its own tile color (the same 14 slots, none new), so the bar reads like the rows
  // below. The name still lives in the tooltip and in those rows (same order, each with its share), so identity
  // never rests on hue alone. "Otros" stays the neutral step.
  const parts = topG.map((g) => {
    const gc = "gc-" + look(g.group)[1];
    return { label: gname(g.group), value: g.value, cls: "is-gc " + gc, key: "sq " + gc, id: g.id };
  });
  if (rest > 0) parts.push({ label: t("others"), value: rest, cls: "gs-6", key: "sq gs-6", id: null });
  const share = (v) => { const s = Math.round((v / c.total) * 100); return s ? s + "%" : "<1%"; };
  const groupHref = (id) => "#/movimientos?" + qs(id ? { month: linkMonth, cat: "g:" + id, tipo: "gastos" } : id === 0 ? { month: linkMonth, tipo: "gastos", estado: "revisar" } : { month: linkMonth, tipo: "gastos" });
  const groupRows = c.groups.map((g) => {
    const [ic, color] = look(g.group);
    return `<a class="row" href="${esc(groupHref(g.id))}">${tile(ic, color)}
      <span class="grow"><span class="title">${esc(gname(g.group))}</span><span class="sub">${esc(`${tn("buys", g.n)} · ${share(g.value)}`)}</span></span>
      <span class="amt">${money(g.value)}</span></a>`;
  }).join("");

  const kindParts = ["E", "G", "A", "M"].filter((k) => c.kinds[k] > 0).map((k) => ({ label: t("kind" + k), value: c.kinds[k], cls: "k-" + k, k }));
  const repeatSub = (s) => (s.amounts.size === 1 ? `${tn("times", s.n)} · ${t("sameAmount")}` : `${tn("times", s.n)} · ${t("avgEach", { x: money(Math.round(s.value / s.n)) })}`);
  const showWeekdays = p.kind !== "semana";
  let topWd = -1;
  c.wdAvg.forEach((v, i) => { if (v != null && (topWd < 0 || v > c.wdAvg[topWd])) topWd = i; });

  await paint(() => (app.innerHTML = `<div data-screen="analisis">${head}
    <section aria-label="${esc(t(p.unit === "month" ? "spentPerMonth" : "spentPerDay"))}">
      <div class="sec-head"><h2>${esc(t(p.unit === "month" ? "spentPerMonth" : "spentPerDay"))}</h2>
        <div class="keys" aria-hidden="true"><span class="key"><i class="fzc-key dash"></i>${esc(t(p.unit === "month" ? "avgMonth" : "avgShort"))} ${money(Math.round(c.avg))}</span></div></div>
      <div class="chart-host" id="anBars"></div>
      <details class="tbl"><summary>${esc(t("seeTable"))}</summary><div id="anBarsTable"></div></details>
    </section>
    <section aria-label="${esc(t("groups"))}">
      <h2>${esc(t("groups"))}</h2>
      <div class="stack-host" id="anGroups"></div>
      <div class="list legend">${groupRows}</div>
    </section>
    ${kindParts.length ? `<section aria-label="${esc(t("kindsTitle"))}">
      <h2>${esc(t("kindsTitle"))}</h2>
      <div class="stack-host" id="anKinds"></div>
      <div class="kind-legend">${kindParts.map((k) => `<span class="k-${k.k}"><i class="sw"></i>${esc(k.label)} <strong>${money(k.value)}</strong></span>`).join("")}</div>
    </section>` : ""}
    <section aria-label="${esc(t("topShops"))}">
      <h2>${esc(t("topShops"))}</h2>
      <div class="list legend">${c.top.map((s) => shopRow(s, tn("buys", s.n), linkMonth)).join("")}</div>
    </section>
    <section aria-label="${esc(t("repeats"))}">
      <h2>${esc(t("repeats"))}</h2>
      ${c.repeats.length ? `<div class="list legend">${c.repeats.map((s) => shopRow(s, repeatSub(s), linkMonth)).join("")}</div>` : `<p class="muted">${esc(t("noRepeats"))}</p>`}
    </section>
    ${showWeekdays ? `<section aria-label="${esc(t("weekdays"))}">
      <div class="sec-head"><h2>${esc(t("weekdays"))}</h2>
        <div class="keys" aria-hidden="true"><span class="key"><i class="fzc-key dash"></i>${esc(t("avgShort"))} ${money(Math.round(c.total / c.nDays))}</span></div></div>
      ${topWd >= 0 ? `<p class="sec-sub">${tHtml("topWeekday", { d: esc(capFirst(weekdayName(topWd, "long"))), x: `<strong>${money(Math.round(c.wdAvg[topWd]))}</strong>` })}</p>` : ""}
      <div class="chart-host" id="anWeek"></div>
      <details class="tbl"><summary>${esc(t("seeTable"))}</summary><div id="anWeekTable"></div></details>
    </section>` : ""}
  </div>`));
  afterPaint(c.total, quiet);
  const animate = !reduced() && !quiet;

  // spending per day (or per month in a year), with the average
  const partial = (s) => p.unit === "month" && s.to >= today && s.from <= today;
  const barItems = p.slots.map((s, i) => ({ label: s.label + (partial(s) ? ` (${t("soFar")})` : ""), short: s.short, value: c.values[i] }));
  charts.push(barsWithAverage(document.getElementById("anBars"), {
    items: barItems, money, avg: c.avg, every: p.kind === "mes" ? 0 : 1, animate,
    // the average value sits in the key above the chart, so no label has to cross the bars
    labels: { aria: t(p.unit === "month" ? "monthsAria" : "barsAria") },
    onSelect: (i) => {
      const s = p.slots[i];
      location.hash = "#/movimientos?" + qs(p.unit === "month" ? { month: s.ym, tipo: "gastos" } : { month: s.from.slice(0, 7), tipo: "gastos", day: s.from });
    },
  }));
  dataTable(document.getElementById("anBarsTable"), null, [t(p.unit === "month" ? "colMonth" : "colDay"), t("colSpent")],
    barItems.filter((it) => it.value != null).map((it) => [it.label, money(it.value)]));

  charts.push(stackedBar(document.getElementById("anGroups"), {
    parts, money, tall: true, animate, labels: { aria: t("groupsAria") },
    onSelect: (i) => { location.hash = groupHref(parts[i].id); },
  }));
  if (kindParts.length) charts.push(stackedBar(document.getElementById("anKinds"), { parts: kindParts, money, tall: true, animate, labels: { aria: t("kindsAria") } }));

  if (showWeekdays) {
    const wdItems = c.wdAvg.map((v, i) => ({ label: capFirst(weekdayName(i, "long")), short: weekdayName(i, "short").replace(".", ""), value: v == null ? null : Math.round(v) }));
    charts.push(barsWithAverage(document.getElementById("anWeek"), {
      items: wdItems, money, avg: c.total / c.nDays, every: 1, animate,
      labels: { aria: t("weekdayAria") },
    }));
    dataTable(document.getElementById("anWeekTable"), null, [t("colDay"), t("weekdayAvg")],
      wdItems.filter((it) => it.value != null).map((it) => [it.label, money(it.value)]));
  }
}

ACT.anPeriod = (el) => {
  const seg = el.closest(".seg");
  const btns = seg ? [...seg.querySelectorAll("button")] : [];
  const from = btns.findIndex((b) => b.getAttribute("aria-pressed") === "true");
  const to = btns.indexOf(el);
  if (from === to) return; // already showing this period
  // answer the tap at once: the thumb glides and the label lights while the numbers load
  btns.forEach((b) => b.setAttribute("aria-pressed", String(b === el)));
  const thumb = seg && seg.querySelector(".seg-thumb");
  if (thumb) {
    thumb.classList.remove("at-" + from);
    thumb.classList.add("at-" + to);
  }
  glideThumb(thumb, from, to);
  segGlide = { from, to, t0: performance.now() };
  navAs("none"); // the control stays put; the content below rises in (afterPaint)
  location.hash = "#/analisis?" + qs({ p: el.dataset.v });
};
ACT.anStep = (el) => {
  if (!cur) return;
  const at = el.dataset.n === "1" ? cur.next : cur.prev;
  if (!at) return;
  navAs(el.dataset.n === "1" ? "next" : "prev");
  location.hash = "#/analisis?" + qs({ p: cur.kind, at });
};
