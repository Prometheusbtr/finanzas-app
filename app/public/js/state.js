// Shared state, page elements and the registries every screen adds to.
// from: the screen before this one. nav: counts screen changes, so a late background redraw can tell it is stale.
// unlock: the Face ID lock's proof for this page (js/lock.js), sent as X-FZ-Unlock. Page memory only, never stored.
export const S = { boot: null, lang: "es", month: null, filters: null, list: null, from: null, nav: 0, unlock: null };
export const app = document.getElementById("app");
export const sheet = document.getElementById("sheet");
export const tabs = document.getElementById("tabs");
// VIEWS: hash path -> async render function. ACT: data-act / data-submit name -> handler.
// PARTS: hash path -> (params) => the [memory key, loader] pairs that screen needs, so a touch can start loading it.
// No prototype, so a hash or a data-act like "constructor" or "__proto__" finds nothing instead of Object's own.
export const VIEWS = Object.create(null);
export const ACT = Object.create(null);
export const PARTS = Object.create(null);
// PUBLIC: hash path -> render function for screens that work without a session (sign-up, Face ID reset).
export const PUBLIC = Object.create(null);
// Set by the login screen, so api.js can show it on a 401 without importing screens.
// step(id, state): save a "Primeros pasos" step (js/screens/pasos.js); Importar calls hooks.step?.(id, "done" | "waiting").
// locked(): the Face ID lock screen (js/lock.js). reauth(method): the fresh check before a sensitive change (js/lock.js).
export const hooks = { authLost: null, step: null, locked: null, reauth: null, keepPush: null, dropPush: null }; // keepPush, dropPush: js/screens/alertas.js (F29)
// Screen data kept in memory between screens (js/data.js cached). Memory only, never stored on the phone.
// api.js empties it after any change and on a 401; a sign out or a session switch reloads the page, which
// wipes it too (other tabs of the app as well, through the "fz-session" channel in api.js).
// gen goes up on every emptying, so a load that started before a change can tell and keep nothing.
export const memo = { map: new Map(), gen: 0 };
