// Lookups over the bootstrap data, loading it, and the screens kept in memory.
import { S, memo, hooks } from "./state.js";
import { t } from "./i18n.js";
import { api } from "./api.js";

// ---------- screens from memory ----------
// Every tab tap used to wait for the server (about 0.2 s per round trip from El Salvador) before the slide even
// started. Now a screen seen before shows at once from memory while fresh data loads behind it, and redraws
// quietly if anything changed. Memory only: nothing is written to the phone. api.js empties it after any change.
const FRESH_MS = 5000; // a value this new is not loaded again (the tap right after a touch started the load)
const MAX_KEYS = 60;

/**
 * What memory holds for `key` (undefined when nothing) and a Promise of a fresh value. A load already running
 * is shared, and a value under FRESH_MS old stands as its own fresh value. A result with the same content as
 * the one in memory keeps the old object, so callers can compare with ===.
 */
export function cached(key, loader) {
  let e = memo.map.get(key);
  if (!e) {
    e = { value: undefined, json: null, at: 0, pending: null };
    memo.map.set(key, e);
    while (memo.map.size > MAX_KEYS) memo.map.delete(memo.map.keys().next().value); // oldest first
  }
  const value = e.value;
  if (e.pending) return { value, fresh: e.pending };
  if (value !== undefined && performance.now() - e.at < FRESH_MS) return { value, fresh: Promise.resolve(value) };
  const gen = memo.gen;
  const p = Promise.resolve()
    .then(loader)
    .then((v) => {
      // A change (api.js forget) happened while this ran: hand it to whoever waits, but keep nothing.
      if (memo.gen !== gen || memo.map.get(key) !== e) return v;
      const j = JSON.stringify(v);
      if (j !== e.json) {
        e.value = v;
        e.json = j;
      }
      e.at = performance.now();
      return e.value;
    })
    .finally(() => {
      if (e.pending === p) e.pending = null;
    });
  e.pending = p;
  return { value, fresh: p };
}
/** Start loading these [key, loader] pairs now (a touch on a tab), unless memory has them fresh. */
export function prefetch(parts) {
  for (const [k, l] of parts) cached(k, l).fresh.catch(() => {});
}
/** Load these only when memory has nothing for them yet (warming the next screens after Home). */
export function warm(parts) {
  for (const [k, l] of parts) {
    const e = memo.map.get(k);
    if (!e || (e.value === undefined && !e.pending)) cached(k, l).fresh.catch(() => {});
  }
}

/**
 * Draw a screen from `parts` ([key, loader] pairs). Seen before: draw(values, false) at once from memory, then,
 * when the fresh values differ, draw(values, true) once more. quiet = true means a background redraw: no intro
 * motion, no scrolling. The quiet one only runs while this is still the newest screen change and nothing was
 * saved in between. Never seen: waits for the load, as before, and draws only if no other screen was asked
 * for meanwhile.
 */
export async function showCached(parts, draw) {
  const nav = S.nav;
  const gen = memo.gen;
  const hits = parts.map(([k, l]) => cached(k, l));
  const fresh = Promise.all(hits.map((h) => h.fresh));
  if (hits.some((h) => h.value === undefined)) {
    const vals = await fresh;
    // another tab was tapped while this loaded (and may already be on screen from memory): leave it there
    if (S.nav !== nav) return;
    return draw(vals, false);
  }
  const old = hits.map((h) => h.value);
  await draw(old, false);
  fresh.then(
    (vals) => {
      if (S.nav !== nav || memo.gen !== gen || vals.every((v, i) => v === old[i])) return;
      Promise.resolve(draw(vals, true)).catch(() => {});
    },
    () => {}, // offline: what memory showed stays on screen
  );
}

export const catById = (id) => S.boot.categories.find((c) => c.id === id);
export const groupById = (id) => S.boot.groups.find((g) => g.id === id);
export const accById = (id) => S.boot.accounts.find((a) => a.id === id);
export const activeCats = () =>
  S.boot.categories.filter((c) => !c.archived && !(groupById(c.group_id) || {}).archived);
export const activeAccounts = () => S.boot.accounts.filter((a) => !a.archived);
/** The active lists plus the one a saved item already uses (archived, or in an archived group), so an edit sheet
 * keeps it selected instead of falling back to "Ninguna" and clearing it on save (F39). */
export const catsWith = (id) => {
  const list = activeCats();
  const cur = id ? catById(id) : null;
  return cur && !list.includes(cur) ? list.concat(cur) : list;
};
export const accountsWith = (id) => S.boot.accounts.filter((a) => !a.archived || a.id === id);
export const catName = (id) => (id ? (catById(id) || {}).name || "?" : t("uncategorized"));
export const accName = (id) => (id ? (accById(id) || {}).name || "?" : "");
export function topCats(n) {
  const out = S.boot.top_categories.map(catById).filter((c) => c && !c.archived);
  for (const c of activeCats()) if (out.length < n && !out.includes(c)) out.push(c);
  return out.slice(0, n);
}

/** Every gasto and abono of one month (YYYY-MM). The server sends at most 300 per page. */
export async function loadSpend(month) {
  const items = [];
  for (let off = 0, pages = 0; pages < 40; pages++) {
    const r = await api(`/movements?month=${month}&tipo=gastos&limit=300&offset=${off}`);
    items.push(...r.items);
    off += r.items.length;
    if (!r.has_more || !r.items.length) break;
  }
  return items;
}
/** One month's spending as a memory entry: Home and Análisis share it. */
export const spendPart = (month) => ["spend:" + month, () => loadSpend(month)];

/** El Salvador's date now (UTC-6 all year, as the server's svNow). */
const svToday = () => new Date(Date.now() - 6 * 3600 * 1000).toISOString().slice(0, 10);
let bootAt = 0;
/**
 * F15: the start data is old when El Salvador's date is no longer its `today` (the app stayed open past midnight)
 * or it is over an hour old. The router then loads it again before drawing.
 */
export const bootStale = () => !!S.boot && (S.boot.today !== svToday() || Date.now() - bootAt > 3600 * 1000);
/** The start data is from an earlier El Salvador day (its `today` would put new purchases on the wrong date). */
export const bootOldDay = () => !!S.boot && S.boot.today !== svToday();

export async function loadBoot() {
  S.boot = await api("/bootstrap");
  bootAt = Date.now();
  S.lang = S.boot.user.lang || "es";
  document.documentElement.lang = S.lang;
  document.querySelectorAll("[data-i18n]").forEach((el) => (el.textContent = t(el.dataset.i18n)));
  // the full word for VoiceOver where the tab shows a short one ("Movs.") or only an icon (+)
  document.querySelectorAll("[data-i18n-label]").forEach((el) => el.setAttribute("aria-label", t(el.dataset.i18nLabel)));
  setBadge(S.boot.review_count);
  hooks.keepPush?.(); // F29, js/screens/alertas.js: once per page load
}
export function setBadge(n) {
  if (S.boot) S.boot.review_count = n;
  const b = document.getElementById("reviewBadge");
  b.hidden = !n;
  b.textContent = n > 99 ? "99+" : String(n);
}
