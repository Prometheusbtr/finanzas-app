// Motion: durations, curves and the Reduced Motion check, in one place.
// Rules: only transform and opacity move (one exception: opening a group animates its height).
// No single animation runs past 340 ms except the chart line (420 ms), and no tap ever waits for an animation.
// (Nov 25 2026: everything shortened by about a quarter, same curves; it felt a bit slow on the iPhone.)
// Reduced Motion (the iPhone setting): a short fade or nothing.
// No styles are written as text: everything goes through element.animate() or classes, so the CSP stays strict.

export const EASE_SHEET = "cubic-bezier(.32,.72,0,1)"; // iOS sheet curve
export const EASE_OUT = "cubic-bezier(.2,.8,.2,1)";
export const DUR = { fast: 150, mid: 220, slow: 340 }; // the same tokens as --dur-* in app.css
export const STAGGER = 18; // ms between rows that rise or grow in one after another
export const COUNT_MS = 300; // the big numbers count up in this long

const rm = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;
/** True while the system asks for reduced motion (read live, so a change applies at once). */
export const reduced = () => !!(rm && rm.matches);
const wide = () => typeof matchMedia === "function" && matchMedia("(min-width: 700px)").matches;

// iOS Safari applies :active (the press feedback) only when the page listens for touches.
document.addEventListener("touchstart", () => {}, { passive: true });

/** element.animate() that never throws on an old browser. Returns the Animation or null. */
export function play(el, frames, opts) {
  if (!el || typeof el.animate !== "function") return null;
  try {
    return el.animate(frames, { duration: DUR.mid, easing: EASE_OUT, ...opts });
  } catch {
    return null;
  }
}

// ---------- screen changes ----------
// Kinds: "tab" and "fade" cross-fade, "push" slides in from the right, "pop" slides back,
// "next" and "prev" move the content one step (month arrows), "none" just swaps.
const root = document.documentElement;
let forced = null;
let kind = null;
let vtNow = null;

/** The next render() animates as this kind instead of the one the router works out. */
export function navAs(k) {
  forced = k;
}
/** For the router: read and clear a kind set by navAs(). */
export function takeNavAs() {
  const k = forced;
  forced = null;
  return k;
}
/** For the router: the kind of change the next paint() shows (null clears it). */
export function setChange(k) {
  kind = k;
}
// F23: where a screen change leaves the page: 0 (the top) for a new screen, the saved position on a step back.
let landY = 0;
/** For the router: the scroll position the next paint() lands on. */
export function setLandY(y) {
  landY = y || 0;
}

/**
 * Run a screen's DOM update. The first call after a navigation animates it (View Transitions where the
 * browser has them, a short fade-up where not); later calls in the same render just run it.
 * Resolves once the new DOM is in place, so the screen can draw its charts into it.
 */
export async function paint(update) {
  const k = kind;
  kind = null;
  const swap = () => {
    update();
    if (k && k !== "none") window.scrollTo(0, landY);
  };
  if (!k || k === "none") return swap();
  const app = document.getElementById("app");
  if (reduced()) {
    swap();
    play(app, [{ opacity: 0 }, { opacity: 1 }], { duration: 120, easing: "linear" });
    return;
  }
  const sheet = document.getElementById("sheet");
  if (typeof document.startViewTransition === "function" && !(sheet && sheet.open) && !document.hidden) {
    root.dataset.vt = wide() && (k === "push" || k === "pop") ? (k === "push" ? "next" : "prev") : k;
    let vt;
    try {
      vt = document.startViewTransition(swap);
    } catch {
      delete root.dataset.vt;
      return swap();
    }
    vtNow = vt;
    vt.ready.catch(() => {});
    vt.finished.catch(() => {}).then(() => {
      if (vtNow === vt) {
        vtNow = null;
        delete root.dataset.vt;
      }
    });
    await vt.updateCallbackDone;
    return;
  }
  swap();
  // F23: no View Transitions (iOS 17 and older): a step back just shows the screen as it was; only a new
  // screen rises in.
  if (k !== "pop") play(app, [{ opacity: 0, transform: "translateY(8px)" }, { opacity: 1, transform: "none" }], { duration: DUR.fast });
}

// ---------- sheets ----------
/** Slide a bottom sheet up (a centered sheet on a wide screen rises a little and fades in). */
export function sheetIn(dlg) {
  if (reduced()) return play(dlg, [{ opacity: 0 }, { opacity: 1 }], { duration: 150, easing: "linear" });
  if (wide()) return play(dlg, [{ opacity: 0, transform: "translateY(24px)" }, { opacity: 1, transform: "none" }], { duration: DUR.mid });
  return play(dlg, [{ transform: "translateY(100%)" }, { transform: "none" }], { duration: DUR.slow, easing: EASE_SHEET });
}
/** Slide it down again, from where a drag left it (fromY px). Stays down (fill forwards) until the caller closes it. */
export function sheetOut(dlg, fromY) {
  if (reduced()) return play(dlg, [{ opacity: 1 }, { opacity: 0 }], { duration: 150, easing: "linear", fill: "forwards" });
  if (wide()) return play(dlg, [{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateY(24px)" }], { duration: DUR.fast, fill: "forwards" });
  return play(dlg, [{ transform: `translateY(${Math.max(0, fromY || 0)}px)` }, { transform: "translateY(100%)" }], { duration: DUR.mid, easing: EASE_OUT, fill: "forwards" });
}
/** After a short drag that did not close it: settle back up. */
export function sheetSettle(dlg, fromY) {
  return play(dlg, [{ transform: `translateY(${Math.max(0, fromY || 0)}px)` }, { transform: "none" }], { duration: DUR.mid, easing: EASE_SHEET });
}

// ---------- content ----------
/** Bars grow from zero (transform only), rows STAGGER ms apart, first `max` bars only. */
export function growBars(root, max = 12) {
  if (reduced()) return;
  [...root.querySelectorAll(".track .fill")].slice(0, max).forEach((f, i) =>
    play(f, [{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }], { duration: DUR.slow, delay: i * STAGGER, fill: "backwards" }),
  );
}
/** The first `max` elements fade up 8 px, staggered. */
export function riseIn(els, max = 12) {
  if (reduced()) return;
  [...els].slice(0, max).forEach((el, i) =>
    play(el, [{ opacity: 0, transform: "translateY(8px)" }, { opacity: 1, transform: "none" }], { duration: DUR.mid, delay: i * STAGGER, fill: "backwards" }),
  );
}
/** Count a number up to its value in COUNT_MS. fmt turns cents into text; the text is set with textContent. */
export function countUp(el, from, to, fmt) {
  if (!el) return;
  if (reduced() || from === to || typeof requestAnimationFrame !== "function") {
    el.textContent = fmt(to);
    return;
  }
  const t0 = performance.now();
  el.textContent = fmt(from);
  const step = (now) => {
    if (!el.isConnected) return;
    const p = Math.min(1, (now - t0) / COUNT_MS);
    const e = 1 - (1 - p) ** 3;
    el.textContent = fmt(Math.round(from + (to - from) * e));
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

const running = new WeakMap();
/**
 * Open or close a panel with a smooth height (the one animation that is not transform or opacity;
 * Safari has no CSS-only way). The caller makes the panel visible before opening; onClosed hides it.
 */
export function slidePanel(panel, open, onClosed) {
  const prev = running.get(panel);
  const cur = panel.getBoundingClientRect().height;
  if (prev) prev.cancel();
  running.delete(panel);
  if (reduced() || typeof panel.animate !== "function") {
    if (!open && onClosed) onClosed();
    return;
  }
  const from = prev || !open ? cur : 0;
  const to = open ? panel.scrollHeight : 0;
  panel.classList.add("is-sliding");
  const a = play(panel, [{ height: from + "px", opacity: open ? (prev ? 1 : 0) : 1 }, { height: to + "px", opacity: open ? 1 : 0 }], { duration: DUR.mid });
  if (!a) {
    panel.classList.remove("is-sliding");
    if (!open && onClosed) onClosed();
    return;
  }
  running.set(panel, a);
  a.finished.then(
    () => {
      running.delete(panel);
      panel.classList.remove("is-sliding");
      if (!open && onClosed) onClosed();
    },
    () => {
      if (!running.has(panel)) panel.classList.remove("is-sliding"); // cancelled by a new tap: that one takes over
    },
  );
}
