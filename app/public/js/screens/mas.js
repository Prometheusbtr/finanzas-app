// Más: a plain grouped list of the screens that are not tabs: Revisar, Funciones' Personas, Tarjetas and
// Recurrentes, and Ajustes.
import { S, app, VIEWS } from "../state.js";
import { t } from "../i18n.js";
import { esc } from "../format.js";
import { icon, tile } from "../look.js";
import { tn } from "../ui.js";
import { paint } from "../motion.js";

// F23: going back to Más shows the same rows (the same nodes, not a rebuild) when nothing in them changed, and
// the row just left lights up briefly and fades, as in iOS Settings.
let kept = null; // { html, nodes }
function showMas(html) {
  if (kept && kept.html === html) app.replaceChildren(...kept.nodes);
  else {
    app.innerHTML = html;
    kept = { html, nodes: [...app.childNodes] };
  }
  const from = S.from && app.querySelector(`a.row[href="#${CSS.escape(S.from)}"]`);
  if (from) {
    from.classList.add("was-tapped");
    setTimeout(() => from.classList.remove("was-tapped"), 300); // about the back slide (DUR.slow)
  }
}

VIEWS["/mas"] = async () => {
  const n = S.boot.review_count;
  await paint(() => showMas(`<h1>${esc(t("moreTab"))}</h1>
    <div class="list grouped">
      <a class="row" data-pre href="#/revisar">${tile("inbox", n ? "accent" : "gray")}
        <span class="grow"><span class="title">${esc(t("review"))}</span>
          <span class="sub">${esc(n ? t("reviewSome", { n: tn("movs", n) }) : t("reviewNone"))}</span></span>
        <span class="side">${n ? `<span class="count">${n > 99 ? "99+" : n}</span>` : ""}${icon("chevron-right", "chev")}</span></a>
      ${fnRows()}
      <a class="row" href="#/ajustes">${tile("settings", "gray")}
        <span class="grow"><span class="title">${esc(t("settings"))}</span><span class="sub">${esc(t("settingsSub"))}</span></span>
        <span class="side">${icon("chevron-right", "chev")}</span></a>
    </div>`));
};

// Funciones (Wave 2)
function fnRows() {
  const row = (href, ic, title, sub) => `<a class="row" data-pre href="${href}">${tile(ic, "gray")}
        <span class="grow"><span class="title">${esc(t(title))}</span><span class="sub">${esc(t(sub))}</span></span>
        <span class="side">${icon("chevron-right", "chev")}</span></a>`;
  return row("#/mas/personas", "users-group", "fnPeople", "fnPeopleSub") + row("#/mas/tarjetas", "credit-card", "fnCards", "fnCardsSub")
    + row("#/mas/recurrentes", "repeat", "fnRecurring", "fnRecurringSub");
}
