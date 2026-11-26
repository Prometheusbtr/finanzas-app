// Review: uncategorized bank rows and merge suggestions.
import { S, app, VIEWS, ACT, PARTS } from "../state.js";
import { t } from "../i18n.js";
import { esc, dateLabel } from "../format.js";
import { api } from "../api.js";
import { setBadge, topCats, showCached } from "../data.js";
import { toast, errText, pickCategory, movRow, backBtn } from "../ui.js";
import { paint } from "../motion.js";
import { catTile } from "../look.js";
import { render } from "../router.js";

PARTS["/revisar"] = () => [["review", () => api("/review")]];
VIEWS["/revisar"] = () => showCached(PARTS["/revisar"](), ([r]) => draw(r));

// F22: money in waiting as ingreso asks "income or refund?"; a refund then takes a category like spending.
const moneyIn = (m) => m.tipo === "ingreso";

async function draw(r) {
  setBadge(r.items.length + r.suggestions.length);
  const top = topCats(6);
  const sugg = r.suggestions
    .map((s) => `<section class="rv" id="sg${s.id}">
      <h3>${esc(t("sameQ"))}</h3>
      <p class="from">${esc(t("bankRow"))} · ${esc(dateLabel(s.bank.fecha))}</p><div class="list">${movRow(s.bank)}</div>
      <p class="from">${esc(t("typedRow"))} · ${esc(dateLabel(s.manual.fecha))}</p><div class="list">${movRow(s.manual)}</div>
      <div class="btns"><button class="btn primary" data-act="sgAccept" data-id="${s.id}">${esc(t("merge"))}</button>
      <button class="btn" data-act="sgReject" data-id="${s.id}">${esc(t("keepBoth"))}</button></div></section>`)
    .join("");
  const items = r.items
    .map((m) => `<section class="rv" id="rv${m.id}">
      <div class="list">${movRow(m)}</div>
      <p class="meta">${esc(dateLabel(m.fecha))} · ${esc(m.origen)}</p>
      ${moneyIn(m) ? `<h3>${esc(t("rvInQ"))}</h3>` : `<div class="chips">${top.map((c) => `<button class="chip" data-act="rvCat" data-id="${m.id}" data-cat="${c.id}">${catTile(c.id, "sm")}${esc(c.name)}</button>`).join("")}
        <button class="chip more" data-act="rvOther" data-id="${m.id}">${esc(t("other"))}</button></div>`}
      <div class="btns">${moneyIn(m)
        ? `<button class="btn" data-act="rvTipo" data-id="${m.id}" data-v="ingreso">${esc(t("isIncome"))}</button>
           <button class="btn" data-act="rvTipo" data-id="${m.id}" data-v="abono">${esc(t("isRefund"))}</button>`
        : `<button class="btn" data-act="rvTipo" data-id="${m.id}" data-v="interno">${esc(t("notSpending"))}</button>`}
        <button class="btn" data-act="rvTipo" data-id="${m.id}" data-v="ignorado">${esc(t("ignore"))}</button></div>
      ${m.raw ? `<details><summary class="small muted">${esc(t("original"))}</summary><pre class="raw">${esc(m.raw)}</pre></details>` : ""}
    </section>`)
    .join("");
  await paint(() => (app.innerHTML = `${backBtn(["/mas", "/"])}<h1>${esc(t("reviewTitle"))}</h1>${sugg}${items}${!sugg && !items ? `<p class="empty">${esc(t("reviewEmpty"))}</p>` : ""}`));
}
async function categorizeReview(id, catId) {
  try {
    const r = await api(`/review/${id}/categorize`, { method: "POST", body: { category_id: catId, apply_same: true } });
    toast(r.also_updated ? t("alsoUpdated", { n: r.also_updated }) : t("done"));
    S.boot = null;
    render();
  } catch (e) {
    toast(errText(e));
  }
}
ACT.rvCat = (el) => categorizeReview(el.dataset.id, Number(el.dataset.cat));
ACT.rvOther = async (el) => {
  const id = await pickCategory(null);
  if (id) categorizeReview(el.dataset.id, id);
};
ACT.rvTipo = async (el) => {
  const v = el.dataset.v;
  try {
    // "Es ingreso" is done (ok); "Es reembolso" stays in Revisar until it gets a category.
    await api(`/movements/${el.dataset.id}`, { method: "PUT", body: v === "ingreso" ? { tipo: v, estado: "ok" } : { tipo: v } });
    toast(t("done"));
    S.boot = null;
    render();
  } catch (e) {
    toast(errText(e));
  }
};
ACT.sgAccept = async (el) => {
  try {
    await api(`/suggestions/${el.dataset.id}/accept`, { method: "POST" });
    toast(t("merged"));
    render();
  } catch (e) {
    toast(errText(e));
  }
};
ACT.sgReject = async (el) => {
  try {
    await api(`/suggestions/${el.dataset.id}/reject`, { method: "POST" });
    render();
  } catch (e) {
    toast(errText(e));
  }
};
