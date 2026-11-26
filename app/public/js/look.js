// How things look: Tabler line icons from /icons.svg and the colored group tiles.
// Color is used only for a group's identity: its tile, and its own block in Análisis "Por grupo", always with the
// group name next to it or in the tooltip.
import { esc } from "./format.js";
import { catById, groupById } from "./data.js";

/** An inline SVG that points at one symbol in /icons.svg. Stroke and size come from CSS. */
export const icon = (name, cls) =>
  `<svg class="ico${cls ? " " + esc(cls) : ""}" aria-hidden="true" focusable="false"><use href="/icons.svg#i-${esc(name)}"></use></svg>`;

// Seed groups by name: [icon, color slot]. A new or renamed group gets the neutral fallback.
const GROUP_LOOK = {
  casa: ["home-2", "blue"], comida: ["tools-kitchen-2", "orange"], transporte: ["car", "cyan"],
  salud: ["first-aid-kit", "red"], personal: ["shirt", "teal"], ocio: ["ticket", "amber"],
  trabajo: ["briefcase", "slate"], familia: ["users-group", "green"], "pareja y personas": ["heart", "pink"],
  "deudas y compartidos": ["arrows-exchange", "brown"], viajes: ["plane", "sky"],
  finanzas: ["building-bank", "emerald"], efectivo: ["cash", "olive"],
};
export const FALLBACK = ["category", "gray"];
const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();

/** [icon, color] for a group name. */
export const groupLook = (name) => GROUP_LOOK[norm(name)] || FALLBACK;

/** A square tile with a white line icon. color is a slot name (blue, orange, ... gray, accent). */
export const tile = (iconName, color, cls) =>
  `<span class="tile gc-${esc(color)}${cls ? " " + esc(cls) : ""}" aria-hidden="true">${icon(iconName)}</span>`;

export const groupTile = (group, cls) => {
  const [ic, color] = group ? groupLook(group.name) : ["question-mark", "gray"];
  return tile(ic, color, cls);
};

/** The tile for a category id (its group's tile), or the "no category" tile. */
export function catTile(categoryId, cls) {
  const c = categoryId ? catById(categoryId) : null;
  return groupTile(c ? groupById(c.group_id) : null, cls);
}

// Rows that are not spending get a neutral tile that says what they are.
const TIPO_LOOK = {
  ingreso: ["arrow-down-left", "accent"],
  interno: ["arrows-left-right", "gray"],
  rechazado: ["ban", "gray"],
  ignorado: ["eye-off", "gray"],
};
export function movTile(m, cls) {
  if (m.tipo === "gasto" || m.tipo === "abono") return catTile(m.category_id, cls);
  const [ic, color] = TIPO_LOOK[m.tipo] || FALLBACK;
  return tile(ic, color, cls);
}

const ACC_ICON = { tarjeta: "credit-card", cuenta: "building-bank", efectivo: "cash", billetera: "wallet" };
export const accountTile = (a, cls) => tile(ACC_ICON[a.kind] || "wallet", "gray", cls);
