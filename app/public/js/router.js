// Hash router plus the click and submit delegation.
import { S, app, sheet, tabs, VIEWS, ACT, PARTS, PUBLIC } from "./state.js";
import { esc } from "./format.js";
import { loadBoot, bootStale, bootOldDay, prefetch } from "./data.js";
import { errText, closeSheet } from "./ui.js";
import { t } from "./i18n.js";
import { setChange, setLandY, takeNavAs, navAs, play, reduced, DUR, EASE_SHEET } from "./motion.js";

function parseHash(hash = location.hash) {
  const h = hash.replace(/^#/, "") || "/";
  const [path, qs] = h.split("?");
  return { path, params: new URLSearchParams(qs || "") };
}

// Which way a screen change goes. Each history entry gets an index in history.state, so Back
// (a lower index) slides the other way. A tap on the tab bar cross-fades; links inside a screen drill in.
let histIndex = 0;
let lastPath = null;
let linkKind = null; // from a tapped link with data-nav (the tab bar: "tab")

// F23: the app keeps each history entry's scroll position itself (page memory, by history index), so a step back
// lands where that screen was, like iOS. The browser's own restore would move the old screen before it leaves.
if ("scrollRestoration" in history) history.scrollRestoration = "manual";
const scrollAt = new Map();
let scrollRaf = 0;
window.addEventListener("scroll", () => {
  if (scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0;
    if (!changing) scrollAt.set(histIndex, window.scrollY);
  });
}, { passive: true });
let changing = false; // between a hash change and the new screen's paint: scrolls then are not the user's
// F23 (d): Safari's edge swipe back already slid the screen, so the app does not slide it a second time.
window.addEventListener("popstate", (e) => {
  if (e.hasUAVisualTransition) navAs("none");
});

/** The tab a path belongs to: Revisar, Ajustes and the Funciones live under Más; Primeros pasos under Home. */
function tabOf(path) {
  return path === "/revisar" || path === "/ajustes" || path.startsWith("/ajustes/") || path.startsWith("/mas/") ? "/mas" : path.startsWith("/pasos/") ? "/" : path;
}
function changeKind(path) {
  const st = history.state && typeof history.state.fz === "number" ? history.state.fz : null;
  let dir = "none";
  if (st == null) {
    histIndex += 1;
    history.replaceState({ ...(history.state || {}), fz: histIndex }, "");
    dir = lastPath == null ? "fade" : "push";
  } else {
    if (st < histIndex) dir = "pop";
    else if (st > histIndex) dir = "push";
    histIndex = st;
  }
  const forced = takeNavAs();
  const fromLink = linkKind;
  linkKind = null;
  if (forced) return forced;
  if (fromLink && dir !== "pop") return fromLink;
  if (lastPath == null) return "fade";
  if (dir !== "none" && path === lastPath) return "fade"; // same screen, other filters
  return dir;
}

export async function render() {
  const nav = ++S.nav; // a newer render makes this one's late results stale (js/data.js showCached)
  if (sheet.open) closeSheet();
  const pub = PUBLIC[parseHash().path];
  if (pub) {
    // Sign-up and Face ID reset links work without a session (js/screens/signup.js).
    tabs.hidden = true;
    lastPath = null;
    try {
      await pub(parseHash().params);
    } catch (e) {
      if (S.nav === nav) app.innerHTML = `<p class="empty">${esc(errText(e))}</p>`;
    }
    return;
  }
  // F26: a screen change while a field had focus (Agregar's save, sign-in, the lock) gets no focusout in WebKit,
  // so the tab bar would stay hidden; it comes back whenever focus is not in a field.
  if (!isField(document.activeElement)) document.body.classList.remove("typing");
  // F15: a new day (or an hour) since the start data: load it again before drawing. The old data stays in S.boot
  // meanwhile (Seguridad, Wave 4 review): code still running from the screen before reads it, and when only the
  // hour ran out and there is no signal, the screen still draws from it instead of a dead error.
  const stale = bootStale();
  if (!S.boot || stale) {
    try {
      await loadBoot();
    } catch (e) {
      // F27: the first load failed (no signal): say so with a way to try again; it also retries by itself when
      // the phone is back online or the app is opened again. Yesterday's data is never drawn as today.
      if (e.code === "auth" || e.code === "unlock") return;
      if (!stale || bootOldDay()) {
        if (S.nav === nav) {
          app.innerHTML = `<div class="empty"><p>${esc(errText(e))}</p>
          <p><button class="btn" type="button" data-act="retryBoot">${esc(t("retry"))}</button></p></div>`;
        }
        return;
      }
    }
    if (S.nav !== nav) return; // another tap came while the bootstrap loaded; that render draws
  }
  tabs.hidden = false;
  const { path, params } = parseHash();
  const tab = tabOf(path);
  tabs.querySelectorAll("a").forEach((a) => (a.dataset.tab === tab ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current")));
  placePill(true);
  const was = histIndex;
  const k = changeKind(path);
  changing = true;
  const back = k === "pop" || (k === "none" && histIndex < was);
  const y = back ? scrollAt.get(histIndex) || 0 : 0;
  setLandY(y);
  setChange(k);
  if (path !== lastPath) S.from = lastPath; // a redraw of the same screen keeps where it came from
  lastPath = path;
  const view = VIEWS[path] || VIEWS["/"];
  try {
    await view(params);
  } catch (e) {
    if (e.code !== "auth" && e.code !== "unlock" && S.nav === nav) app.innerHTML = `<p class="empty">${esc(errText(e))}</p>`;
  }
  if (S.nav !== nav) return; // a newer screen change owns the motion kind and the scroll
  setChange(null);
  window.scrollTo(0, y);
  changing = false;
  scrollAt.set(histIndex, window.scrollY);
}
window.addEventListener("hashchange", render);
ACT.retryBoot = () => render();
const isField = (el) => !!(el && el.matches && el.matches("input:not([type=checkbox]):not([type=radio]), textarea, select"));
/** Whether a form on the screen holds something she typed or picked that is not saved yet. */
function edited(root) {
  return [...root.querySelectorAll("input, textarea, select")].some((el) =>
    el.type === "checkbox" || el.type === "radio" ? el.checked !== el.defaultChecked
      : el.tagName === "SELECT" ? !!el.options.length && !([...el.options].find((o) => o.defaultSelected) || el.options[0]).selected
      : el.type !== "file" && el.value !== el.defaultValue);
}
/** F15, F27: back online, or the app opened again: draw again when the start data is missing or old (never over an
 * open sheet, a field she is typing in, or a form she filled and left, as when she checks another app halfway
 * through Agregar: then only the start data is loaded again, behind the screen). */
function wake() {
  if (document.hidden || sheet.open || isField(document.activeElement) || PUBLIC[parseHash().path]) return;
  if (!S.boot) {
    if (app.querySelector("[data-act=retryBoot]")) render();
    return;
  }
  if (!bootStale()) return;
  if (edited(app)) loadBoot().catch(() => {});
  else render();
}
window.addEventListener("online", wake);
document.addEventListener("visibilitychange", wake);

// Start loading a screen's data on the touch itself, before the tap ends (about 0.1 s sooner than the click),
// for the tab bar and for links marked data-pre. Not for every link: a finger that scrolls a list of rows would
// start a load for each row it lands on.
document.addEventListener(
  "pointerdown",
  (e) => {
    if (!S.boot || e.button > 0) return;
    const a = e.target.closest && e.target.closest("#tabs a[href], a[data-pre]");
    if (!a) return;
    const { path, params } = parseHash(a.getAttribute("href") || "");
    try {
      if (PARTS[path]) prefetch(PARTS[path](params));
    } catch {} // only a head start: the screen loads on its own anyway
  },
  { capture: true, passive: true },
);

// The back button on screens inside Más (Ajustes, Revisar). A Home Screen app has no browser Back, so this is
// the way out. When the app's own history holds the screen it names, go back there (it slides back); otherwise
// (the screen was opened from a link or a reload) open that screen as a step back.
ACT.back = (el) => {
  const to = el.dataset.to === "/" ? "/" : el.dataset.to === "/ajustes" ? "/ajustes" : "/mas"; // only these parents exist
  const st = history.state && typeof history.state.fz === "number" ? history.state.fz : 0;
  if (S.from === to && st > 1) return history.back();
  navAs("pop");
  location.hash = "#" + to;
};

// ---------- the tab bar's selection pill ----------
const pill = tabs.querySelector(".tab-pill");
let pillX = null;
/** Move the soft pill under the lit tab; it glides there (translateX) unless this is the first placement. */
function placePill(animate) {
  if (!pill) return;
  const a = tabs.querySelector('a[aria-current="page"]:not(.tab-add)');
  if (!a || tabs.hidden) {
    pill.classList.remove("on");
    return;
  }
  const x = a.offsetLeft;
  pill.style.width = a.offsetWidth + "px";
  pill.style.transform = `translateX(${x}px)`;
  const wasOn = pill.classList.contains("on");
  pill.classList.add("on");
  if (animate && wasOn && pillX != null && pillX !== x && !reduced()) {
    play(pill, [{ transform: `translateX(${pillX}px)` }, { transform: `translateX(${x}px)` }], { duration: DUR.mid, easing: EASE_SHEET });
  }
  pillX = x;
}
if (typeof ResizeObserver !== "undefined") new ResizeObserver(() => placePill(false)).observe(tabs);

// Click and submit handlers by data-act, since the security policy forbids inline handlers.
document.addEventListener("click", (e) => {
  const link = e.target.closest("a[href]");
  if (link) linkKind = link.dataset.nav || null; // a tap on the tab that is already lit changes nothing, so reset on every link
  // F31: a tap on the lit tab, as on iOS: inside one of its screens it steps back to the tab's first screen; on
  // that screen it scrolls to the top. Never a new history step.
  if (link && link.dataset.nav === "tab" && S.boot) {
    const root = link.dataset.tab;
    const { path } = parseHash();
    if (tabOf(path) === root) {
      e.preventDefault();
      linkKind = null;
      if (path === root) {
        window.scrollTo({ top: 0, behavior: reduced() ? "auto" : "smooth" });
        return;
      }
      const st = history.state && typeof history.state.fz === "number" ? history.state.fz : 0;
      if (S.from === root && st > 1) return history.back();
      navAs("pop");
      location.replace("#" + root);
      return;
    }
  }
  const el = e.target.closest("[data-act]");
  if (!el) {
    if (e.target === sheet) closeSheet(); // tap on the dark backdrop
    return;
  }
  const fn = ACT[el.dataset.act];
  if (fn) {
    e.preventDefault();
    fn(el, e);
  }
});
document.addEventListener("submit", (e) => {
  const fn = ACT[e.target.dataset.submit];
  if (fn) {
    e.preventDefault();
    fn(e.target, e);
  }
});
ACT.close = () => closeSheet();
