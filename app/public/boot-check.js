// F42: if the app has not started a few seconds after the page loaded (a module failed to load or link, for
// example after an update on a weak signal), say so and offer a clean reload instead of "Cargando…" forever.
// A plain script (the security policy allows no inline code); app.js sets window.__fzStarted as it starts.
(function () {
  var WAIT_MS = 8000;
  function show() {
    if (window.__fzStarted) return;
    var main = document.getElementById("app");
    if (!main || !main.querySelector(".skel")) return; // something else is already on screen
    var es = (document.documentElement.lang || navigator.language || "es").slice(0, 2) !== "en";
    var p = document.createElement("p");
    p.textContent = es ? "No se pudo abrir la app." : "The app could not open.";
    var b = document.createElement("button");
    b.type = "button";
    b.className = "btn primary";
    b.textContent = es ? "Recargar" : "Reload";
    b.addEventListener("click", function () {
      b.disabled = true;
      // drop this app's stored files, so the reload takes every file from the network, all of one version
      var clear = window.caches && caches.keys
        ? caches.keys().then(function (keys) {
          return Promise.all(keys.filter(function (k) { return k.indexOf("fz-shell-") === 0; }).map(function (k) { return caches.delete(k); }));
        })
        : Promise.resolve();
      clear.catch(function () {}).then(function () { location.reload(); });
    });
    var box = document.createElement("div");
    box.className = "empty";
    box.appendChild(p);
    box.appendChild(b);
    main.replaceChildren(box);
  }
  setTimeout(show, WAIT_MS);
})();
