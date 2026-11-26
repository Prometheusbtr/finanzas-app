// Runs before the page paints so a saved Light or Dark choice does not flash. "system" = no attribute.
try {
  var t = localStorage.getItem("fz_theme");
  if (t === "light" || t === "dark") document.documentElement.setAttribute("data-theme", t);
} catch (e) {}
