// Finanzas front end. Plain JavaScript modules, no build step. Talks to /api/* on the same Worker.
// Every piece of text from the bank or the user goes through esc() (js/format.js) before it reaches innerHTML.
// Each screen module registers its views and actions when imported.
import { render } from "./js/router.js";
import "./js/screens/login.js";
import "./js/screens/home.js";
import "./js/screens/add.js";
import "./js/screens/review.js";
import "./js/screens/movements.js";
import "./js/screens/settings.js";
import "./js/screens/analisis.js";
import "./js/screens/mas.js";
import "./js/screens/importar.js";
import "./js/lock.js";
import "./js/screens/signup.js";
import "./js/screens/pasos.js";
import "./js/screens/cuenta.js";
// Funciones (Wave 2): Personas, Tarjetas, Recurrentes, Alertas and Home's extras
import "./js/screens/personas.js";
import "./js/screens/tarjetas.js";
import "./js/screens/recurrentes.js";
import "./js/screens/alertas.js";
import "./js/screens/extras.js";

// While typing on a phone, hide the tab bar so it does not float above the keyboard.
const isField = (el) => el && el.matches && el.matches("input:not([type=checkbox]):not([type=radio]), textarea, select");
document.addEventListener("focusin", (e) => {
  if (isField(e.target) && matchMedia("(pointer: coarse)").matches) document.body.classList.add("typing");
});
document.addEventListener("focusout", () => {
  setTimeout(() => {
    if (!isField(document.activeElement)) document.body.classList.remove("typing");
  }, 50);
});
window.__fzStarted = true; // every module loaded and linked (boot-check.js waits for this)
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
render();
