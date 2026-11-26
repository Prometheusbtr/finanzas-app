// pdf.js worker, same origin: the newest builtins pdf.js 6 uses first (older phones lack some), then the
// vetted worker file itself, unchanged.
import "./compat.js";
import "../vendor/pdfjs-6.5.438/pdf.worker.min.mjs";
