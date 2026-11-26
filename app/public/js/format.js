// Formatting and parsing helpers. Every piece of text from the bank or the user goes through esc() before innerHTML.
import { locale } from "./i18n.js";
import { parseCents } from "./numbers.js";

export const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
export function money(cents, sign) {
  const neg = cents < 0;
  const abs = Math.abs(Math.round(cents));
  const whole = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const txt = `$${whole}.${String(abs % 100).padStart(2, "0")}`;
  return (neg ? "−" : sign && cents > 0 ? "+" : "") + txt;
}
/** Whole dollars ("$1,626"): Home's group rows and the caption under the bar. Cents show everywhere else. */
export function moneyWhole(cents) {
  const d = Math.round(Math.abs(cents) / 100);
  return (cents < 0 && d ? "−" : "") + "$" + d.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
export { parseCents } from "./numbers.js";
export const centsToInput = (c) => (c == null ? "" : (c / 100).toFixed(2));
export function dateLabel(fecha, opts) {
  const [y, m, d] = fecha.split("-").map(Number);
  return new Intl.DateTimeFormat(locale(), { timeZone: "UTC", ...(opts || { weekday: "short", day: "numeric", month: "short" }) })
    .format(new Date(Date.UTC(y, m - 1, d)));
}
export function monthLabel(ym) {
  const [y, m] = ym.split("-").map(Number);
  const s = new Intl.DateTimeFormat(locale(), { timeZone: "UTC", month: "long", year: "numeric" }).format(new Date(Date.UTC(y, m - 1, 1)));
  return s.charAt(0).toUpperCase() + s.slice(1); // "Noviembre de 2026", not "Noviembre De 2026"
}
/** Just the month's name: "noviembre" in Spanish, "November" in English. */
export function monthName(ym) {
  const [y, m] = ym.split("-").map(Number);
  return new Intl.DateTimeFormat(locale(), { timeZone: "UTC", month: "long" }).format(new Date(Date.UTC(y, m - 1, 1)));
}
export const capFirst = (s) => s.charAt(0).toUpperCase() + s.slice(1);
export function shiftMonth(ym, n) {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}
export function randomId() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}
export function applyBars(root) {
  root.querySelectorAll("[data-w]").forEach((el) => (el.style.width = Math.max(0, Math.min(100, Number(el.dataset.w))) + "%"));
  root.querySelectorAll("[data-x]").forEach((el) => (el.style.left = Math.max(0, Math.min(100, Number(el.dataset.x))) + "%"));
}
export const splitTags = (s) => [...new Set(String(s || "").split(",").map((x) => x.trim()).filter(Boolean))].slice(0, 10);
export const dollarsToCents = (v) => {
  const s = String(v).trim();
  if (!s) return null;
  return parseCents(s, { zero: true });
};
