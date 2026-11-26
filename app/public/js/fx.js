// Funciones (Wave 2), Moneda: the optional "Otra moneda" part of the add and edit screens. A purchase in pesos
// keeps its pesos and the rate; totals stay in dollars (amount_cents). No rates from outside: she types the rate
// or the dollar amount. Wise: dollars sent (with the fee), what arrived, and the fee.
import { t } from "./i18n.js";
import { esc, money, parseCents, centsToInput } from "./format.js";
import { parseRate } from "./numbers.js";

/** The same list as src/lib/fx.ts and the CHECK in migration 0005. */
export const CURRENCIES = ["COP", "EUR", "MXN", "GTQ", "HNL", "NIO", "CRC", "PEN", "CAD", "GBP", "BRL", "DOP"];

/** "40,000.00 COP" (her own amount, never added into anything). */
export function fxText(fx) {
  if (!fx) return "";
  const whole = Math.floor(fx.cents / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${whole}.${String(fx.cents % 100).padStart(2, "0")} ${fx.currency}`;
}

// up to 6 decimals, the precision the rate is kept in, so opening and saving a movement never changes its rate
const rateText = (micros) => (micros ? String(micros / 1_000_000) : "");

const MAX_USD = 10000000; // the dollar cap of parseCents

/** The fields, inside their own fold. fx: the movement's saved one (or null). */
export function fxFields(fx) {
  const cur = fx ? fx.currency : "COP";
  return `<details class="more fx"${fx ? " open" : ""}><summary>${esc(t("fnFx"))}${fx ? ` <span class="muted">${esc(fxText(fx))}</span>` : ""}</summary>
    <div class="two"><label class="field"><span>${esc(t("fnFxCurrency"))}</span><select name="fxCur" data-fx="cur">${CURRENCIES.map((c) => `<option value="${c}" ${c === cur ? "selected" : ""}>${c}</option>`).join("")}</select></label>
    <label class="field"><span>${esc(t("fnFxAmount"))}</span><input name="fxAmt" data-fx="amt" inputmode="decimal" value="${fx ? centsToInput(fx.cents) : ""}"></label></div>
    <div class="two"><label class="field"><span>${esc(t("fnFxRate"))}</span><input name="fxRate" data-fx="rate" inputmode="decimal" value="${fx ? esc(rateText(fx.micros)) : ""}"></label>
    <label class="field"><span>${esc(t("fnFxFee"))}</span><input name="fxFee" data-fx="fee" inputmode="decimal" value="${fx && fx.fee_cents != null ? centsToInput(fx.fee_cents) : ""}"></label></div>
    <p class="hint num" data-fx="usd" aria-live="polite" hidden></p>
    <p class="hint">${esc(t("fnFxHint"))}</p>
  </details>`;
}

/**
 * Read the fields under `root`. usdCents: the dollar amount she typed (or null). Returns { fx, usdCents, error }:
 * fx null when no other-currency amount is typed; usdCents worked out from the rate when she left dollars empty.
 */
export function readFx(root, usdCents) {
  const get = (k) => root.querySelector(`[data-fx="${k}"]`);
  if (!get("amt")) return { fx: null, usdCents, error: null };
  if (!get("amt").value.trim()) return { fx: null, usdCents, error: null };
  const cents = parseCents(get("amt").value, { max: 1e14 }); // pesos run far past the dollar cap
  if (!cents) return { fx: null, usdCents, error: t("invalidAmount") };
  const cur = get("cur").value;
  const r = parseRate(get("rate").value, cur);
  if (r.error) return { fx: null, usdCents, error: t(r.error, { x: r.x }) };
  const rate = r.rate;
  const feeText = get("fee").value.trim();
  const fee = feeText ? parseCents(feeText, { zero: true }) : null;
  if (feeText && fee == null) return { fx: null, usdCents, error: t("invalidAmount") };
  let usd = usdCents;
  if (!usd && rate) usd = Math.round(cents / rate) + (fee || 0);
  if (!usd) return { fx: null, usdCents, error: t("fnFxNeedRate") };
  if (usd < 1 || usd > MAX_USD) return { fx: null, usdCents, error: t("fnFxBadUsd", { x: money(usd) }) };
  const fx = { currency: cur, cents };
  if (rate) fx.micros = Math.round(rate * 1_000_000);
  if (fee) fx.fee_cents = fee;
  return { fx, usdCents: usd, error: null };
}

/** The dollars the rate gives, shown under the fields while she types, so a 100x slip shows before Guardar. */
function showUsd(form) {
  const out = form.querySelector('[data-fx="usd"]');
  if (!out) return;
  const dollars = form.querySelector('[name="amount"], #amt');
  const typed = dollars && dollars.value.trim() ? parseCents(dollars.value) : null;
  const r = readFx(form, null);
  out.hidden = !(r.fx && r.fx.micros && !typed);
  out.textContent = out.hidden ? "" : t("fnFxIsUsd", { x: money(r.usdCents) });
}
document.addEventListener("input", (e) => {
  const el = e.target;
  if (!el.closest || !(el.closest("[data-fx]") || el.matches('[name="amount"], #amt'))) return;
  const form = el.closest("form") || el.closest("#app");
  if (form) showUsd(form);
});
document.addEventListener("change", (e) => {
  if (e.target.matches && e.target.matches('[data-fx="cur"]')) showUsd(e.target.closest("form") || e.target.closest("#app"));
});
