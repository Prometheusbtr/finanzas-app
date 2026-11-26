// Small SVG chart helpers for Finanzas. No chart library and no innerHTML: every label is
// set with textContent, so bank text can never run as code. Works under the strict CSP
// (no inline style attributes; positions are set through element.style, colors through CSS).
//
// Colors come from CSS custom properties on (or above) the host element:
//   --fzc-line   the series stroke        --fzc-area   the series wash (about 10% opacity)
//   --fzc-pace   reference / average line --fzc-grid   hairline gridlines
//   --fzc-axis   baseline                 --fzc-ink    value text
//   --fzc-muted  axis and label text      --fzc-surface the chart background (rings, gaps)
//   --fzc-bar    bar fill                 --fzc-bar-hot hovered or selected bar
// Stacked parts take their color from a class the caller passes (part.cls).

const NS = "http://www.w3.org/2000/svg";

function svgEl(tag, attrs, parent) {
  const n = document.createElementNS(NS, tag);
  if (attrs) for (const k of Object.keys(attrs)) if (attrs[k] != null) n.setAttribute(k, String(attrs[k]));
  if (parent) parent.appendChild(n);
  return n;
}
function svgText(parent, x, y, str, cls, anchor) {
  const t = svgEl("text", { x, y, class: cls, "text-anchor": anchor || "start" }, parent);
  t.textContent = str;
  return t;
}
function htmlEl(tag, cls, parent, txt) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (txt != null) n.textContent = txt;
  if (parent) parent.appendChild(n);
  return n;
}

/** A clean tick step for about `count` ticks up to `max`. */
export function niceStep(max, count) {
  if (!(max > 0)) return 1;
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const f = raw / mag;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * mag;
}
/** Axis label for a cents value: whole dollars in full under 10,000, compact above. */
export function axisMoney(cents) {
  const d = Math.round(cents / 100);
  if (Math.abs(d) >= 10000) return "$" + (d / 1000).toFixed(d % 1000 === 0 ? 0 : 1) + "K";
  return "$" + d.toLocaleString("en-US");
}

/** Keep re-drawing when the host width changes; returns a cleanup function. */
function watchWidth(host, draw) {
  let last = -1;
  const run = () => {
    const w = Math.floor(host.clientWidth);
    if (w >= 40 && w !== last) { // below 40 px there is nothing to draw (a window being measured, a hidden host)
      last = w;
      draw(w);
    }
  };
  run();
  if (typeof ResizeObserver === "undefined") return () => {};
  const ro = new ResizeObserver(run);
  ro.observe(host);
  return () => ro.disconnect();
}

const EASE_OUT = "cubic-bezier(.2,.8,.2,1)"; // the app's ease-out (js/motion.js)
const canAnimate = (el) => typeof el.animate === "function";

/** One tooltip per chart: rows of [value, label, keyClass]. Values lead, labels follow. It fades in and out (opacity only). */
function makeTip(wrap) {
  const tip = htmlEl("div", "fzc-tip", wrap);
  tip.setAttribute("role", "status");
  tip.hidden = true;
  let fadeOut = null;
  return {
    show(title, rows, x, wrapWidth) {
      if (fadeOut) {
        fadeOut.cancel();
        fadeOut = null;
      }
      const wasHidden = tip.hidden;
      tip.replaceChildren();
      htmlEl("div", "fzc-tip-title", tip, title);
      for (const [value, label, key] of rows) {
        const r = htmlEl("div", "fzc-tip-row", tip);
        if (key) htmlEl("i", "fzc-key " + key, r);
        htmlEl("strong", null, r, value);
        htmlEl("span", null, r, label);
      }
      tip.hidden = false;
      const w = tip.offsetWidth;
      const left = Math.max(0, Math.min(wrapWidth - w, x - w / 2));
      tip.style.left = left + "px";
      if (wasHidden && canAnimate(tip)) tip.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 120, easing: "linear" });
    },
    hide() {
      if (tip.hidden || fadeOut) return;
      if (!canAnimate(tip)) {
        tip.hidden = true;
        return;
      }
      const a = (fadeOut = tip.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 120, easing: "linear", fill: "forwards" }));
      a.finished.then(() => {
        if (fadeOut !== a) return;
        fadeOut = null;
        tip.hidden = true;
        a.cancel();
      }, () => {});
    },
  };
}

/**
 * Running spend for one month against a straight pace line.
 * opts: {
 *   days: number of days in the month,
 *   values: cumulative cents through day 1..N (N = days with data, may be 0),
 *   limit: limit in cents (0 = no pace line),
 *   money(cents) -> "$1,234.56", dayLabel(d, short) -> "25 nov",
 *   labels: { spent, pace, paceEnd, limit, aria },
 *   animate: draw the line left to right on the first draw (transforms only),
 *   height (default 164)
 * }
 * With a limit, the only y reference is the limit line (labelled) with the dashed pace line ending on it
 * ("Ritmo" at its end); without one, light gridlines with values.
 * Returns { destroy }.
 */
export function runningLine(host, opts) {
  const { days, values, limit, money, dayLabel } = opts;
  const L = opts.labels || {};
  const H = opts.height || 164;
  const wrap = htmlEl("div", "fzc fzc-running");
  host.replaceChildren(wrap);
  const tip = makeTip(wrap);
  const n = values.length;
  const last = n ? values[n - 1] : 0;
  const maxV = Math.max(limit || 0, ...values, 1);
  let intro = !!opts.animate; // only the first draw animates, not a redraw on resize

  const stop = watchWidth(host, (W) => {
    wrap.querySelectorAll("svg, .fzc-reveal").forEach((s) => s.remove());
    const padT = 18, padB = 22, padL = 0, padR = 2;
    const plotH = H - padT - padB;
    const yMax = maxV * 1.1; // a little air above the highest point; ticks stay on clean values below it
    const step = niceStep(yMax, 3);
    const x = (d) => padL + ((d - 1) / Math.max(1, days - 1)) * (W - padL - padR);
    const y = (v) => padT + plotH - (v / yMax) * plotH;

    const svg = svgEl("svg", {
      class: "fzc-svg", width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: "img", tabindex: 0,
      "aria-label": L.aria || "",
    });
    wrap.insertBefore(svg, wrap.firstChild);
    // reference lines sit in a layer behind the spending line; labels, the dot and the hover layer stay on top
    const back = svgEl("svg", { class: "fzc-layer", width: W, height: H, viewBox: `0 0 ${W} ${H}`, "aria-hidden": "true", focusable: "false" });
    wrap.insertBefore(back, svg);

    if (limit > 0) {
      // the limit as one solid hairline, and the pace line from day 1 up to it at month end
      svgEl("line", { class: "fzc-limit", x1: 0, x2: W, y1: y(limit), y2: y(limit) }, back);
      svgEl("line", { class: "fzc-pace", x1: x(1), y1: y(limit / days), x2: x(days), y2: y(limit) }, back);
    } else {
      // no limit: light gridlines, labels on the line, left aligned
      const g = svgEl("g", { class: "fzc-grid" }, back);
      for (let v = step; v <= yMax; v += step) {
        svgEl("line", { x1: 0, x2: W, y1: y(v), y2: y(v) }, g);
        svgText(svg, 0, y(v) - 4, axisMoney(v), "fzc-tick");
      }
    }
    svgEl("line", { class: "fzc-axis", x1: 0, x2: W, y1: y(0), y2: y(0) }, back);
    const ticks = [1, 8, 15, 22, days];
    ticks.forEach((d, i) => {
      const anchor = i === 0 ? "start" : i === ticks.length - 1 ? "end" : "middle";
      svgText(svg, x(d), H - 6, dayLabel(d, i !== 0), "fzc-tick", anchor);
    });

    // running spend: wash and line in their own layer under the labels, so the first draw can reveal
    // it left to right by moving a clip box (transform only, no stroke tricks)
    let reveal = null;
    let dot = null;
    let lbl = null;
    if (n) {
      const pts = values.map((v, i) => [x(i + 1), y(v)]);
      const line = pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join("");
      const lastX = pts[n - 1][0];
      reveal = htmlEl("div", "fzc-reveal");
      const inner = htmlEl("div", "fzc-reveal-in", reveal);
      const layer = svgEl("svg", { class: "fzc-layer", width: W, height: H, viewBox: `0 0 ${W} ${H}`, "aria-hidden": "true", focusable: "false" }, inner);
      svgEl("path", { class: "fzc-area", d: `${line}L${lastX.toFixed(1)} ${y(0)}L${pts[0][0].toFixed(1)} ${y(0)}Z` }, layer);
      svgEl("path", { class: "fzc-line", d: line }, layer);
      wrap.insertBefore(reveal, svg); // between the reference layer and the labels
      dot = svgEl("circle", { class: "fzc-dot", cx: lastX, cy: pts[n - 1][1], r: 4.5 }, svg);
      // end label: the one value printed on the chart
      const right = lastX > W * 0.62;
      lbl = svgText(svg, right ? lastX - 9 : lastX + 9, pts[n - 1][1] - 9, money(last), "fzc-value", right ? "end" : "start");
      if (lbl.getBBox().y < 0) lbl.setAttribute("y", String(pts[n - 1][1] + 18));
    }

    // the limit's name on its line (left) and "Ritmo" where the dashed line ends (right), instead of a legend
    const refs = [];
    if (limit > 0) {
      if (L.limit) refs.push(svgText(svg, 0, y(limit) - 6, L.limit, "fzc-label fzc-halo", "start"));
      if (L.paceEnd) refs.push(svgText(svg, W - padR, y(limit) - 6, L.paceEnd, "fzc-label fzc-halo", "end"));
    }
    if (lbl && refs.length) {
      const hits = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
      const clash = () => refs.some((r) => r.isConnected && hits(lbl.getBBox(), r.getBBox()));
      if (clash()) lbl.setAttribute("y", String(Number(dot.getAttribute("cy")) + 18)); // under the dot instead
      if (clash()) refs.forEach((r) => hits(lbl.getBBox(), r.getBBox()) && r.remove()); // the value wins; the tooltip still names the line
    }

    if (intro && reveal && canAnimate(reveal)) {
      const t = { duration: 420, easing: EASE_OUT };
      reveal.animate([{ transform: "translateX(-100%)" }, { transform: "none" }], t);
      reveal.firstChild.animate([{ transform: "translateX(100%)" }, { transform: "none" }], t);
      dot.animate([{ transform: "scale(0)" }, { transform: "scale(1)" }], { duration: 150, delay: 390, easing: EASE_OUT, fill: "backwards" });
      lbl.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 150, delay: 360, easing: "linear", fill: "backwards" });
    }
    intro = false;

    // hover / touch / keyboard layer: a crosshair that snaps to the nearest day
    const cross = svgEl("line", { class: "fzc-cross", x1: 0, x2: 0, y1: padT - 6, y2: y(0), visibility: "hidden" }, svg);
    const hot = svgEl("circle", { class: "fzc-dot", r: 4.5, visibility: "hidden" }, svg);
    const hit = svgEl("rect", { class: "fzc-hit", x: 0, y: 0, width: W, height: H }, svg);
    let cur = null;
    const showDay = (d) => {
      cur = d;
      wrap.classList.add("is-hover"); // the tooltip carries the numbers; the end label steps aside
      const cx = x(d);
      cross.setAttribute("x1", String(cx));
      cross.setAttribute("x2", String(cx));
      cross.setAttribute("visibility", "visible");
      const rows = [];
      if (d <= n) {
        rows.push([money(values[d - 1]), L.spent || "", "line"]);
        hot.setAttribute("cx", String(cx));
        hot.setAttribute("cy", String(y(values[d - 1])));
        hot.setAttribute("visibility", "visible");
      } else hot.setAttribute("visibility", "hidden");
      if (limit > 0) rows.push([money(Math.round((limit * d) / days)), L.pace || "", "dash"]);
      tip.show(dayLabel(d, false), rows, cx, W);
    };
    const hide = () => {
      cur = null;
      wrap.classList.remove("is-hover");
      cross.setAttribute("visibility", "hidden");
      hot.setAttribute("visibility", "hidden");
      tip.hide();
    };
    const dayAt = (evt) => {
      const r = svg.getBoundingClientRect();
      const px = ((evt.clientX - r.left) / r.width) * W;
      return Math.max(1, Math.min(days, Math.round(((px - padL) / (W - padL - padR)) * (days - 1)) + 1));
    };
    hit.addEventListener("pointermove", (e) => showDay(dayAt(e)));
    hit.addEventListener("pointerdown", (e) => showDay(dayAt(e)));
    hit.addEventListener("pointerleave", hide);
    svg.addEventListener("focus", () => showDay(n || 1));
    svg.addEventListener("blur", hide);
    svg.addEventListener("keydown", (e) => {
      const d = cur || n || 1;
      const next = { ArrowLeft: d - 1, ArrowRight: d + 1, Home: 1, End: days }[e.key];
      if (e.key === "Escape") return hide();
      if (next == null) return;
      e.preventDefault();
      showDay(Math.max(1, Math.min(days, next)));
    });
  });
  return { destroy: stop };
}

/**
 * Bars (one per period, e.g. per day) with a dashed average line.
 * opts: { items: [{ label, short, value }], money, labels: { avg, aria }, height, onSelect(i), avg, every }
 * every (optional): label every Nth bar; the default keeps about six labels.
 * value null = a slot still to come (a future day): its label is drawn, no bar, no hit target.
 * avg (optional) overrides the plain mean of the bars, e.g. when the last bar is a part period.
 */
export function barsWithAverage(host, opts) {
  const { items, money } = opts;
  const L = opts.labels || {};
  const H = opts.height || 150;
  const wrap = htmlEl("div", "fzc fzc-bars");
  host.replaceChildren(wrap);
  const tip = makeTip(wrap);
  const vals = items.map((it) => (it.value == null ? null : Math.max(0, it.value)));
  const real = vals.filter((v) => v != null);
  const avg = opts.avg != null ? opts.avg : real.length ? real.reduce((a, b) => a + b, 0) / real.length : 0;
  const maxV = Math.max(...real, avg, 1);
  let intro = !!opts.animate; // only the first draw grows the bars, not a redraw on resize

  const stop = watchWidth(host, (W) => {
    wrap.querySelectorAll("svg").forEach((s) => s.remove());
    const drawn = [];
    const padT = 18, padB = 20;
    const plotH = H - padT - padB;
    const yMax = maxV * 1.1;
    const step = niceStep(yMax, 3);
    const y = (v) => padT + plotH - (v / yMax) * plotH;
    const ticks = [];
    for (let v = step; v <= yMax; v += step) ticks.push(v);
    // a left gutter for the y labels, so no bar ever runs under them
    const padL = Math.max(0, ...ticks.map((v) => axisMoney(v).length)) * 7 + 6;
    const band = (W - padL) / Math.max(1, items.length);
    const bw = Math.max(2, Math.min(24, band - 2)); // capped at 24px, at least a 2px gap
    const svg = svgEl("svg", { class: "fzc-svg", width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": L.aria || "" });
    wrap.insertBefore(svg, wrap.firstChild);
    const g = svgEl("g", { class: "fzc-grid" }, svg);
    ticks.forEach((v) => svgEl("line", { x1: padL, x2: W, y1: y(v), y2: y(v) }, g));
    const every = opts.every || Math.ceil(items.length / 6);
    items.forEach((it, i) => {
      const cx = padL + band * i + band / 2;
      const v = vals[i];
      const top = y(v);
      const base = y(0);
      const r = Math.min(4, bw / 2, base - top);
      const x0 = cx - bw / 2;
      const x1 = cx + bw / 2;
      // rounded data end, square at the baseline
      const d = v > 0
        ? `M${x0} ${base}V${top + r}Q${x0} ${top} ${x0 + r} ${top}H${x1 - r}Q${x1} ${top} ${x1} ${top + r}V${base}Z`
        : "";
      const bar = d ? svgEl("path", { class: "fzc-bar", d }, svg) : null;
      if (bar) drawn.push(bar);
      const lastI = items.length - 1;
      if (i === lastI || (i % every === 0 && lastI - i >= Math.ceil(every / 2))) svgText(svg, cx, H - 5, it.short ?? it.label, "fzc-tick", "middle");
      if (v == null) return; // still to come: no bar and nothing to hover
      // F37: the text says the real amount (a refund day is negative); only the bar's height stops at zero
      const hit = svgEl("rect", { class: "fzc-hit", x: padL + band * i, y: 0, width: band, height: H, tabindex: 0, role: "button", "aria-label": `${it.label}: ${money(it.value)}` }, svg);
      const on = () => {
        if (bar) bar.classList.add("is-hot");
        tip.show(it.label, [[money(it.value), ""]], cx, W);
      };
      const off = () => {
        if (bar) bar.classList.remove("is-hot");
        tip.hide();
      };
      hit.addEventListener("pointerenter", on);
      hit.addEventListener("pointerleave", off);
      hit.addEventListener("focus", on);
      hit.addEventListener("blur", off);
      if (opts.onSelect) {
        hit.addEventListener("click", () => opts.onSelect(i));
        hit.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            opts.onSelect(i);
          }
        });
      }
    });
    svgEl("line", { class: "fzc-axis", x1: padL, x2: W, y1: y(0), y2: y(0) }, svg);
    // y labels in the left gutter, level with their grid line
    ticks.forEach((v) => svgText(svg, 0, y(v) + 4, axisMoney(v), "fzc-tick"));
    if (avg > 0) {
      svgEl("line", { class: "fzc-pace", x1: padL, x2: W, y1: y(avg), y2: y(avg) }, svg);
      // printed on a surface-colored halo so it stays readable where it crosses a bar
      if (L.avg) svgText(svg, W - 2, y(avg) - 5, `${L.avg} ${money(Math.round(avg))}`, "fzc-label fzc-halo", "end");
    }
    // intro: each bar grows up from the baseline (scaleY, origin in CSS), left to right, all done within 340 ms
    if (intro && canAnimate(svg)) {
      const gapMs = drawn.length > 1 ? Math.min(9, 120 / (drawn.length - 1)) : 0;
      drawn.forEach((b, i) => b.animate([{ transform: "scaleY(0)" }, { transform: "scaleY(1)" }], { duration: 220, delay: i * gapMs, easing: EASE_OUT, fill: "backwards" }));
    }
    intro = false;
  });
  return { destroy: stop };
}

/**
 * One whole split into parts (segmented bar). Thin: 8px, no text. Tall: 28px, share printed
 * inside a part only when it fits. 2px surface gap between parts.
 * opts: { parts: [{ label, value, cls }], money, tall, labels: { aria }, onSelect(i) }
 */
export function stackedBar(host, opts) {
  const { parts, money } = opts;
  const tall = !!opts.tall;
  const H = tall ? 28 : 8;
  const wrap = htmlEl("div", "fzc fzc-stack" + (tall ? " is-tall" : ""));
  host.replaceChildren(wrap);
  const tip = makeTip(wrap);
  const shown = parts.filter((p) => p.value > 0);
  const total = shown.reduce((a, p) => a + p.value, 0);
  let intro = !!opts.animate; // only the first draw fills in, not a redraw on resize

  const stop = watchWidth(host, (W) => {
    wrap.querySelectorAll("svg").forEach((s) => s.remove());
    const svg = svgEl("svg", { class: "fzc-svg", width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": (opts.labels && opts.labels.aria) || "" });
    wrap.insertBefore(svg, wrap.firstChild);
    if (!total) {
      svgEl("rect", { class: "fzc-track", x: 0, y: 0, width: W, height: H, rx: H / 2 }, svg);
      return;
    }
    const gap = 2;
    const usable = W - gap * (shown.length - 1);
    let x0 = 0;
    shown.forEach((p, i) => {
      const w = Math.max(1, (p.value / total) * usable);
      const g = svgEl("g", { class: "fzc-part " + (p.cls || ""), tabindex: 0, role: "button" }, svg);
      const share = Math.round((p.value / total) * 100);
      g.setAttribute("aria-label", `${p.label}: ${money(p.value)}, ${share}%`);
      const rect = svgEl("rect", { x: x0, y: 0, width: w, height: H, rx: tall ? 4 : H / 2 }, g);
      let label = null;
      if (tall) {
        label = svgText(g, x0 + 8, H / 2 + 4, share + "%", "fzc-inlabel");
        if (label.getComputedTextLength() + 16 > w) { label.remove(); label = null; } // does not fit: legend and tooltip carry it
      }
      // intro: each part fills in from its left edge (scaleX, origin in CSS), then its share fades in; done within 340 ms
      if (intro && canAnimate(rect)) {
        rect.animate([{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }], { duration: 220, delay: i * 22, easing: EASE_OUT, fill: "backwards" });
        if (label) label.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 100, delay: 110 + i * 22, easing: "linear", fill: "backwards" });
      }
      const cx = x0 + w / 2;
      const on = () => {
        g.classList.add("is-hot");
        tip.show(p.label, [[money(p.value), share + "%", p.key]], cx, W);
      };
      const off = () => {
        g.classList.remove("is-hot");
        tip.hide();
      };
      g.addEventListener("pointerenter", on);
      g.addEventListener("pointerleave", off);
      g.addEventListener("focus", on);
      g.addEventListener("blur", off);
      if (opts.onSelect) {
        g.addEventListener("click", () => opts.onSelect(parts.indexOf(p)));
        g.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            opts.onSelect(parts.indexOf(p));
          }
        });
      }
      x0 += w + gap;
    });
    intro = false;
  });
  return { destroy: stop };
}

/** The table view every chart needs (accessible twin). headers: [..], rows: [[..], ..]. Text only. */
export function dataTable(container, caption, headers, rows) {
  const table = htmlEl("table", "fzc-table");
  if (caption) htmlEl("caption", null, table, caption);
  const thead = htmlEl("thead", null, table);
  const hr = htmlEl("tr", null, thead);
  headers.forEach((h, i) => {
    const th = htmlEl("th", i ? "num" : null, hr, h);
    th.scope = "col";
  });
  const tbody = htmlEl("tbody", null, table);
  for (const r of rows) {
    const tr = htmlEl("tr", null, tbody);
    r.forEach((c, i) => {
      const cell = htmlEl(i ? "td" : "th", i ? "num" : null, tr, c);
      if (!i) cell.scope = "row";
    });
  }
  container.replaceChildren(table);
  return table;
}
