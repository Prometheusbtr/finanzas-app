// Funciones (Wave 2), the parts Home shows from /api/home/extras: the alert banners (limit 80% and 100%, a card due
// soon, Sunday's summary, the evening cash reminder), the "next 14 days" strip (only when something is due) and the
// fixed payments still to come this month, which count against the limit. home.js only places these.
import { S, ACT } from "../state.js";
import { t } from "../i18n.js";
import { esc, money, moneyWhole, dateLabel } from "../format.js";
import { api } from "../api.js";
import { toast, errText, tn } from "../ui.js";
import { icon, tile } from "../look.js";
import { dueText } from "./tarjetas.js";
import { setPeopleOn } from "./personas.js";

const EMPTY = { committed_cents: 0, committed_limited_cents: 0, upcoming: [], banners: [], people_on: false };
/** Where a banner (and a notification) opens: fixed screens only. sw.js has the same map. */
export const OPEN = { card: "#/mas/tarjetas", limit: "#/", week: "#/analisis?p=semana", cash: "#/agregar" };
const BANNER_ICON = { card: "credit-card", lim100: "chart-bar", lim80: "chart-bar", week: "calendar-due", cash: "cash" };

/** Home's extra memory entry. Only the current month has anything (past months stay as they were). */
export const extrasPart = (month) => [
  "extras:" + month,
  () => (month === S.boot.today.slice(0, 7)
    ? api("/home/extras?month=" + month).then((x) => (setPeopleOn(x.people_on), x)).catch((e) => {
      if (e.code === "auth" || e.code === "unlock") throw e;
      return EMPTY; // Home still shows without them
    })
    : Promise.resolve(EMPTY)),
];

/** Fixed payments not yet paid this month, inside groups with a limit: Home's "Te quedan" takes them off. */
export const committedCents = (x) => (x && x.committed_limited_cents > 0 ? x.committed_limited_cents : 0);

/** "Incluye $120 de pagos fijos que faltan este mes", under the meter, only when there are some. */
export function committedNote(x, s) {
  const c = committedCents(x);
  if (!c || !s.limit_cents) return "";
  return `<a class="note fn-committed" href="#/mas/recurrentes">${esc(t("fnCommittedNote", { x: moneyWhole(c) }))}</a>`;
}

const SHOW = 2; // banners shown before "N más"
export function bannersHtml(x) {
  if (!x || !x.banners.length) return "";
  const one = (b) => `<div class="fn-banner${b.kind === "lim100" ? " bad" : ""}" role="status">
      <a href="${OPEN[b.open] || "#/"}">${icon(BANNER_ICON[b.kind] || "bell")}<span>${esc(b.text)}</span></a>
      <button class="iconbtn" type="button" data-act="fnBannerX" data-key="${esc(b.key)}" aria-label="${esc(t("close"))}">${icon("x")}</button></div>`;
  const rest = x.banners.slice(SHOW);
  return `<div class="fn-banners">${x.banners.slice(0, SHOW).map(one).join("")}
    ${rest.length ? `<button class="see fn-more" type="button" data-act="fnBannersMore" aria-expanded="false" aria-controls="fnMore">${esc(tn("fnMoreAlerts", rest.length))}${icon("chevron-down")}</button>
      <div class="fn-banners" id="fnMore" hidden>${rest.map(one).join("")}</div>` : ""}</div>`;
}
ACT.fnBannersMore = (el) => {
  const more = document.getElementById("fnMore");
  if (!more) return;
  more.hidden = !more.hidden;
  el.setAttribute("aria-expanded", String(!more.hidden));
};

export function upcomingHtml(x) {
  if (!x || !x.upcoming.length) return "";
  const today = S.boot.today;
  const rows = x.upcoming.slice(0, 5).map((u) => {
    const href = u.kind === "card" ? "#/mas/tarjetas" : "#/mas/recurrentes";
    const when = u.kind === "card" ? dueText(today, u.fecha) : u.fecha === today ? t("fnToday") : dateLabel(u.fecha);
    return `<a class="lrow fn-up" href="${href}">${tile(u.kind === "card" ? "credit-card" : "repeat", "gray")}
      <span class="mid"><span class="name">${esc(u.name)}</span><span class="lim">${esc(when)}</span></span>
      <span class="amts num"><span class="amt">${u.amount_cents != null ? esc(money(u.amount_cents)) : ""}</span></span>${icon("chevron-right", "chev")}</a>`;
  }).join("");
  return `<section class="fn-upcoming" aria-label="${esc(t("fnNext14"))}"><h2>${esc(t("fnNext14"))}</h2><div class="ledger">${rows}</div></section>`;
}

ACT.fnBannerX = async (el) => {
  const box = el.closest(".fn-banner");
  try {
    await api("/alerts/dismiss", { method: "POST", body: { key: el.dataset.key } });
    if (box) box.remove();
  } catch (e) {
    toast(errText(e));
  }
};
