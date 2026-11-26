// Home: what is left this month (one big number), the running spend line, Revisar only when something
// waits, and the groups (one line each, whole dollars). Every name from the user or the bank goes through esc().
import { S, app, VIEWS, ACT, PARTS } from "../state.js";
import { t } from "../i18n.js";
import { esc, money, moneyWhole, shiftMonth, applyBars, dateLabel, monthName, capFirst } from "../format.js";
import { api } from "../api.js";
import { setBadge, spendPart, showCached, warm } from "../data.js";
import { render } from "../router.js";
import { icon, tile, groupLook } from "../look.js";
import { tn, tHtml } from "../ui.js";
import { runningLine, dataTable, axisMoney } from "../charts.js";
import { paint, navAs, growBars, countUp, slidePanel, reduced } from "../motion.js";
import { setupPart, setupCard, startHtml, markStandalone } from "./pasos.js";
import { extrasPart, committedCents, committedNote, bannersHtml, upcomingHtml } from "./extras.js"; // Funciones
import { resetBanner } from "./cuenta.js"; // a Face ID reset link for her that is still open

let chart = null;
let shown = 0; // the big number on screen, so a month change counts from it

const pad = (n) => String(n).padStart(2, "0");

/** Running spend per day inside groups with a limit (the same rule as limited_spent_cents). */
function running(s, items) {
  const limited = new Set();
  for (const g of s.groups) if (g.limit_cents != null && !g.archived) for (const c of g.cats) limited.add(c.id);
  const perDay = new Array(s.days).fill(0);
  for (const m of items) {
    if (!limited.has(m.category_id)) continue;
    const d = Number(m.fecha.slice(8, 10));
    if (d >= 1 && d <= s.days) perDay[d - 1] += m.tipo === "gasto" ? m.amount_cents : m.tipo === "abono" ? -m.amount_cents : 0;
  }
  const cum = [];
  let run = 0;
  for (let i = 0; i < s.day; i++) cum.push((run += perDay[i]));
  return cum;
}

/** The one big number: what is left (limit minus spending inside limits), or how far over. */
function headline(s, isCurrent, committed = 0) {
  if (!s.limit_cents) return { label: t("heroSpent"), cents: s.spent_cents, over: false };
  const left = s.limit_cents - s.limited_spent_cents - committed; // Funciones: fixed payments still to come count too
  if (left < 0) return { label: t("heroOver"), cents: -left, over: true };
  return { label: t(isCurrent ? "heroLeft" : "heroLeftPast"), cents: left, over: false };
}

/** The bar with today's tick, and one caption line: "$1,626 de $1,935" and "$51/día · 6 días". */
function meter(s, isCurrent, committed = 0) {
  const lim = s.limit_cents;
  const used = s.limited_spent_cents;
  if (!lim) return "";
  const over = used > lim;
  const pct = (s.day / s.days) * 100;
  const daysLeft = s.days - s.day + 1; // today still counts
  let right = "";
  if (isCurrent && !over) right = `${t("perDay", { x: moneyWhole(Math.max(0, Math.floor((lim - used - committed) / daysLeft / 100) * 100)) })} · ${tn("days", daysLeft)}`;
  else if (isCurrent) right = tn("daysLeft", daysLeft);
  return `<div class="meter">
    <div class="track" role="meter" aria-valuemin="0" aria-valuemax="${lim}" aria-valuenow="${Math.min(used, lim)}"
      aria-label="${esc(t("usedOf", { x: money(used), limit: money(lim) }))}">
      <i class="fill${over ? " bad" : ""}" data-w="${((used / lim) * 100).toFixed(2)}"></i>
      ${isCurrent ? `<b class="tick" aria-hidden="true" data-x="${pct.toFixed(2)}"></b>` : ""}
    </div>
    <div class="meter-cap num">
      <span>${tHtml("usedOf", { x: `<strong${over ? ' class="over"' : ""}>${moneyWhole(used)}</strong>`, limit: moneyWhole(lim) })}</span>
      ${right ? `<span>${esc(right)}</span>` : ""}
    </div>
  </div>`;
}

// ---------- weekly "Te quedan" (Feature 3): only when Home extras carries a week (this month, per week) ----------
function weekHeadline(w) {
  if (w.budget_cents == null) return { label: t("heroSpentWeek"), cents: w.spent_cents, over: false };
  const left = w.budget_cents - w.spent_cents;
  if (left < 0) return { label: t("heroOverWeek"), cents: -left, over: true };
  return { label: t("heroLeftWeek"), cents: left, over: false };
}
/** "Semana del 23 al 29 nov" (the month on both ends when it changes) and last week's result. */
function weekLine(w) {
  const sameMonth = w.start.slice(0, 7) === w.end.slice(0, 7);
  const dm = { day: "numeric", month: "short" };
  const range = t("weekRange", { a: dateLabel(w.start, sameMonth ? { day: "numeric" } : dm).replace(".", ""), b: dateLabel(w.end, dm).replace(".", "") });
  let last = "";
  if (w.last) {
    const L = w.last;
    if (L.budget_cents == null) last = t("lastWeekSpent", { x: money(L.spent_cents) });
    else {
      const d = L.budget_cents - L.spent_cents;
      last = Math.abs(d) < 100 ? t("lastWeekEven") : d > 0 ? t("lastWeekLeft", { x: money(d) }) : t("lastWeekOver", { x: money(-d) });
    }
  }
  return `<p class="weeknote"><span>${esc(range)}</span>${last ? `<span>${esc(last)}</span>` : ""}</p>`;
}
/** The week's bar: seven days, today's tick, "$62 de $150" and "$22/día · 5 días". */
function weekMeter(w) {
  const lim = w.budget_cents;
  const used = w.spent_cents;
  if (!lim) return weekLine(w);
  const over = used > lim;
  const daysLeft = 8 - w.day; // today still counts
  const right = over ? tn("daysLeft", daysLeft)
    : `${t("perDay", { x: moneyWhole(Math.max(0, Math.floor((lim - used) / daysLeft / 100) * 100)) })} · ${tn("days", daysLeft)}`;
  return `<div class="meter">
    <div class="track" role="meter" aria-valuemin="0" aria-valuemax="${lim}" aria-valuenow="${Math.max(0, Math.min(used, lim))}"
      aria-label="${esc(t("usedOf", { x: money(used), limit: money(lim) }))}">
      <i class="fill${over ? " bad" : ""}" data-w="${Math.max(0, (used / lim) * 100).toFixed(2)}"></i>
      <b class="tick" aria-hidden="true" data-x="${((w.day / 7) * 100).toFixed(2)}"></b>
    </div>
    <div class="meter-cap num">
      <span>${tHtml("usedOf", { x: `<strong${over ? ' class="over"' : ""}>${moneyWhole(used)}</strong>`, limit: moneyWhole(lim) })}</span>
      <span>${esc(right)}</span>
    </div>
  </div>${weekLine(w)}`;
}

function groupRow(g, month) {
  const [ic, color] = groupLook(g.name);
  const lim = g.limit_cents;
  const over = !!lim && g.spent_cents > lim;
  const cats = g.cats.filter((c) => c.spent_cents);
  const said = lim ? t("usedOf", { x: money(g.spent_cents), limit: money(lim) }) : money(g.spent_cents);
  return `<details class="grp" data-g="${g.id}"><summary data-act="grp"><span class="lrow">${tile(ic, color)}
      <span class="mid"><span class="name">${esc(g.name)}</span>
        ${lim ? `<span class="track thin" aria-hidden="true"><i class="fill${over ? " bad" : ""}" data-w="${((g.spent_cents / lim) * 100).toFixed(2)}"></i></span>` : ""}</span>
      <span class="amts num" aria-hidden="true"><span class="amt${over ? " over" : ""}">${moneyWhole(g.spent_cents)}</span>${lim ? `<span class="lim">/ ${moneyWhole(lim)}</span>` : ""}</span>
      <span class="sr">${esc(said)}</span>${icon("chevron-down", "chev")}
    </span></summary>
    <div class="cats">
      ${cats.map((c) => `<a class="cat" href="#/movimientos?month=${esc(month)}&cat=c:${c.id}&tipo=gastos"><span>${esc(c.name)}</span>
        <span class="num">${money(c.spent_cents)}${c.limit_cents != null ? `<span class="lim">${esc(t("ofX", { x: money(c.limit_cents) }))}</span>` : ""}</span></a>`).join("")}
      <a class="see" href="#/movimientos?month=${esc(month)}&cat=g:${g.id}&tipo=gastos">${esc(t("seeMovements"))}${icon("chevron-right")}</a>
    </div></details>`;
}

/** Over-limit groups first, then by share of the limit used; groups without a limit after, biggest first. */
function sortGroups(a, b) {
  const ra = a.limit_cents ? a.spent_cents / a.limit_cents : -1;
  const rb = b.limit_cents ? b.spent_cents / b.limit_cents : -1;
  const oa = ra > 1 ? 1 : 0;
  const ob = rb > 1 ? 1 : 0;
  if (oa !== ob) return ob - oa;
  if (ra !== rb) return rb - ra;
  return b.spent_cents - a.spent_cents;
}

function groupRows(s, month) {
  const groups = s.groups.filter((g) => !g.archived && (g.spent_cents || g.limit_cents));
  const spent = groups.filter((g) => g.spent_cents).sort(sortGroups);
  const zero = groups.filter((g) => !g.spent_cents);
  const rows = spent.map((g) => groupRow(g, month));
  if (s.uncategorized_cents) {
    rows.push(`<a class="lrow" href="#/revisar">${tile("question-mark", "gray")}
      <span class="mid"><span class="name">${esc(t("uncategorized"))}</span></span>
      <span class="amts num"><span class="amt">${moneyWhole(s.uncategorized_cents)}</span></span>${icon("chevron-right", "chev")}</a>`);
  }
  if (!rows.length && !zero.length) return `<p class="empty">${esc(t("noSpendMonth"))}</p>`;
  const fold = zero.length
    ? `<button class="lrow fold" type="button" data-act="fold" aria-expanded="false" aria-controls="zeroGroups">
        <span class="name">${esc(tn("zeroGroups", zero.length))}</span>${icon("chevron-down", "chev")}</button>
      <div class="ledger zero" id="zeroGroups" hidden>${zero.map((g) => groupRow(g, month)).join("")}</div>`
    : "";
  return `<div class="ledger">${rows.join("")}</div>${fold}`;
}

// Home's data: the month summary plus that month's spending (the same memory entry Análisis uses for the month),
// and the "Primeros pasos" card (js/screens/pasos.js).
const homeParts = (month) => [["summary:" + month, () => api("/summary?month=" + month)], spendPart(month), setupPart(), extrasPart(month)];
PARTS["/"] = () => homeParts(S.month || S.boot.today.slice(0, 7));

VIEWS["/"] = async () => {
  const month = S.month || S.boot.today.slice(0, 7);
  await showCached(homeParts(month), ([s, items, setup, extras], quiet) =>
    setup.has_movements ? draw(month, s, items, quiet, setup, extras) : drawStart(s, setup));
  // While the person looks at Home, load the two screens most often opened next, once each, so their first
  // tap shows at once too (Análisis's month is already in memory when Home shows the current month).
  setTimeout(() => {
    if (!S.boot) return;
    warm(PARTS["/movimientos"](new URLSearchParams()));
    warm(PARTS["/analisis"](new URLSearchParams()));
  }, 300);
};

/** Home before her first movement: the card and two ways to start (never an empty page). */
async function drawStart(s, setup) {
  if (chart) chart.destroy();
  chart = null;
  setBadge(s.review_count);
  markStandalone(setup);
  await paint(() => {
    app.innerHTML = `<header class="hello"><h1>${esc(t("psHello", { name: S.boot.user.display_name }))}</h1></header>${resetBanner(S.boot.reset_pending)}${startHtml(setup)}`;
  });
  applyBars(app);
}

/** Draw Home. quiet: a background redraw with fresher numbers (no intro motion; open groups stay open). */
async function draw(month, s, items, quiet, setup, extras) {
  markStandalone(setup);
  const today = S.boot.today;
  const openGroups = quiet ? [...app.querySelectorAll("details.grp.is-open")].map((d) => d.dataset.g) : [];
  const foldOpen = quiet && !!app.querySelector('[data-act="fold"][aria-expanded="true"]');
  if (chart) chart.destroy();
  chart = null;
  setBadge(s.review_count);
  const isCurrent = month === today.slice(0, 7);
  const lim = s.limit_cents;
  const used = s.limited_spent_cents;
  const pace = lim ? Math.round((lim * s.day) / s.days) : 0;
  const cum = running(s, items);
  const committed = isCurrent ? committedCents(extras) : 0; // Funciones (Recurrentes)
  const wk = isCurrent && extras && extras.week ? extras.week : null; // per week (Ajustes → Tu presupuesto)
  const head = wk ? weekHeadline(wk) : headline(s, isCurrent, committed);
  const n = s.review_count;
  let chip = "";
  if (lim && isCurrent) {
    const diff = used - pace;
    chip = Math.abs(diff) < 100
      ? `<span class="pchip">${esc(t("onPaceChip"))}</span>`
      : `<span class="pchip num${diff > 0 ? " over" : ""}">${esc(t(diff > 0 ? "overPaceChip" : "underPaceChip", { x: money(Math.abs(diff)) }))}</span>`;
  }
  const income = s.income_cents ? `<span class="sub num">${esc(t("incomeX", { x: money(s.income_cents) }))}</span>` : "";
  const year = month.slice(0, 4) !== today.slice(0, 4) ? ` <span class="yr">${esc(month.slice(0, 4))}</span>` : "";

  await paint(() => {
    app.innerHTML = `<header class="monthbar">
      <button class="iconbtn" data-act="month" data-n="-1" aria-label="${esc(t("prevMonth"))}">${icon("chevron-left")}</button>
      <h1>${esc(capFirst(monthName(month)))}${year}</h1>
      <button class="iconbtn" data-act="month" data-n="1" aria-label="${esc(t("nextMonth"))}" ${isCurrent ? "disabled" : ""}>${icon("chevron-right")}</button>
    </header>
    ${resetBanner(S.boot.reset_pending)}${setupCard(setup)}${bannersHtml(extras)}
    <section class="summary boxed" aria-label="${esc(t("monthSummary"))}">
      <p class="eyebrow">${esc(head.label)}</p>
      <p class="hero num${head.over ? " over" : ""}${head.cents >= 1000000 ? " is-long" : ""}"><span class="sr">${money(head.cents)}</span><span id="heroNum" aria-hidden="true">${money(head.cents)}</span></p>
      ${wk ? weekMeter(wk) : meter(s, isCurrent, committed) + committedNote(extras, s)}
      ${lim || wk ? `<a class="totalrow" data-pre href="#/movimientos?month=${esc(month)}&tipo=gastos"><span class="grow"><span>${esc(t("totalMonth"))}</span>${income}</span>
        <strong class="num">${money(s.spent_cents)}</strong>${icon("chevron-right", "chev")}</a>`
        : `<p class="note">${esc(t("noLimits"))}</p>`}
    </section>
    ${upcomingHtml(extras)}
    <section class="chart" aria-label="${esc(t("running"))}">
      <div class="sec-head"><h2>${esc(t("running"))}</h2>${chip}</div>
      <div class="chart-host is-running" id="runHost"></div>
      <details class="tbl"><summary>${esc(t("byDayTable"))}</summary><div id="runTable"></div></details>
    </section>
    ${n ? `<a class="lrow review-row" data-pre href="#/revisar">${tile("inbox", "accent")}<span class="name">${esc(t("review"))}</span>
      <span class="count">${n > 99 ? "99+" : n}</span>${icon("chevron-right", "chev")}</a>` : ""}
    <section class="groups" aria-label="${esc(t("groups"))}">
      <h2>${esc(t("groups"))}</h2>
      ${groupRows(s, month)}
    </section>`;
  });
  applyBars(app);
  if (quiet) {
    if (foldOpen) {
      const btn = app.querySelector('[data-act="fold"]');
      const panel = btn && document.getElementById(btn.getAttribute("aria-controls"));
      if (panel) {
        btn.setAttribute("aria-expanded", "true");
        panel.hidden = false;
        applyBars(panel);
      }
    }
    for (const id of openGroups) {
      const d = app.querySelector(`details.grp[data-g="${CSS.escape(id)}"]`);
      if (d) {
        d.classList.add("is-open");
        d.open = true;
      }
    }
  } else growBars(app);
  countUp(document.getElementById("heroNum"), shown, head.cents, money);
  shown = head.cents;

  const dayLabel = (d, short) => (short ? String(d) : dateLabel(`${month}-${pad(d)}`, { day: "numeric", month: "short" }));
  const rows = [];
  let prev = 0;
  cum.forEach((v, i) => {
    rows.push([dayLabel(i + 1, false), money(v - prev), money(v), lim ? money(Math.round((lim * (i + 1)) / s.days)) : ""]);
    prev = v;
  });
  dataTable(document.getElementById("runTable"), null, [t("colDay"), t("colOfDay"), t("colRunning"), t("colPace")], rows);
  chart = runningLine(document.getElementById("runHost"), {
    days: s.days, values: cum, limit: lim, money, dayLabel, animate: !reduced() && !quiet,
    labels: {
      spent: t("spentWord"), pace: t("paceWord"), paceEnd: t("pace"), limit: lim ? t("limitShort", { x: axisMoney(lim) }) : "",
      aria: lim ? t("runningAriaLim", { x: money(used), limit: money(lim) }) : t("runningAria", { x: money(used) }),
    },
  });
}

ACT.month = (el) => {
  const cur = S.month || S.boot.today.slice(0, 7);
  const n = Number(el.dataset.n);
  const next = shiftMonth(cur, n);
  if (next > S.boot.today.slice(0, 7)) return;
  S.month = next;
  navAs(n > 0 ? "next" : "prev");
  render();
};

// A group opens with a smooth height; its chevron turns at once (the class), the panel follows.
ACT.grp = (summary) => {
  const d = summary.parentElement;
  const panel = d.querySelector(".cats");
  if (d.classList.contains("is-open")) {
    d.classList.remove("is-open");
    slidePanel(panel, false, () => (d.open = false));
  } else {
    d.classList.add("is-open");
    d.open = true;
    slidePanel(panel, true);
  }
};
// "3 grupos sin gasto": a real button that shows the folded rows.
ACT.fold = (btn) => {
  const panel = document.getElementById(btn.getAttribute("aria-controls"));
  if (!panel) return;
  const open = btn.getAttribute("aria-expanded") !== "true";
  btn.setAttribute("aria-expanded", String(open));
  if (open) {
    panel.hidden = false;
    applyBars(panel);
    slidePanel(panel, true);
  } else slidePanel(panel, false, () => (panel.hidden = true));
};
