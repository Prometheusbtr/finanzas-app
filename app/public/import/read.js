// Read a statement file on the phone. Loaded with import() only on the import screen. The file never leaves
// the phone: pdf.js reads PDFs (in its own worker), a background worker parses CSV, and only rows go on.
import "./compat.js";
import * as pdfjs from "../vendor/pdfjs-6.5.438/pdf.min.mjs";
import { pdfItems, MAX_PAGES } from "./pdf-items.js";
import { readStatement } from "./parse.js";
import { MAX_CSV_BYTES } from "./csv.js";

export const MAX_PDF_BYTES = 10 * 1024 * 1024;
export const TIMEOUT_MS = 30_000;

// Same origin, no blob: URL (worker-src 'self'). The wrapper loads compat.js first, then the vetted worker.
pdfjs.GlobalWorkerOptions.workerSrc = "/import/pdf-worker.js";

function fail(code) {
  const e = new Error(code);
  e.code = code;
  return e;
}

function withTimeout(promise, onTimeout) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        onTimeout();
        reject(fail("timeout"));
      }, TIMEOUT_MS);
    }),
  ]);
}

/**
 * A PDF file -> statement ({ kind, rows, check, period, ... }). password: kept only in this call's memory.
 * Errors (e.code): too_big, too_many_pages, password (needs one), bad_password, unknown_pdf, bad_file, timeout.
 */
export async function readPdf(file, password) {
  if (file.size > MAX_PDF_BYTES) throw fail("too_big");
  const data = new Uint8Array(await file.arrayBuffer());
  // The vetted options (SECURITY.md, "pdf.js"). No font, CMap, ICC or WASM URLs: nothing is fetched. Errors only in
  // the console: the standard-font warnings for statements that do not embed their fonts change nothing for text.
  const task = pdfjs.getDocument({
    data, useWasm: false, enableXfa: false, disableFontFace: true, useSystemFonts: false, verbosity: pdfjs.VerbosityLevel.ERRORS,
  });
  // pdf.js asks for the password through onPassword: hand it over once; asked again means it was wrong.
  let tries = 0;
  const locked = new Promise((_, reject) => {
    task.onPassword = (update) => {
      if (password && tries++ === 0) return update(password);
      reject(fail(password ? "bad_password" : "password"));
    };
  });
  locked.catch(() => {});
  const work = (async () => {
    let doc;
    try {
      doc = await Promise.race([task.promise, locked]);
    } catch (e) {
      if (e && (e.code === "password" || e.code === "bad_password")) throw e;
      if (e && e.name === "PasswordException") throw fail(password ? "bad_password" : "password");
      throw fail("bad_file");
    }
    if (doc.numPages > MAX_PAGES) throw fail("too_many_pages");
    const st = readStatement(await pdfItems(doc));
    if (!st) throw fail("unknown_pdf");
    return st;
  })();
  try {
    return await withTimeout(work, () => task.destroy().catch(() => {}));
  } finally {
    task.destroy().catch(() => {});
  }
}

/** A CSV file -> table ({ header, rows }), parsed in a background worker. */
export function readCsvFile(file) {
  if (file.size > MAX_CSV_BYTES) return Promise.reject(fail("too_big"));
  return file.arrayBuffer().then((buffer) => {
    const w = new Worker("/import/csv-worker.js", { type: "module" });
    const done = new Promise((resolve, reject) => {
      w.onmessage = (e) => (e.data && e.data.ok ? resolve(e.data.table) : reject(fail((e.data && e.data.code) || "bad_file")));
      w.onerror = () => reject(fail("bad_file"));
    });
    w.postMessage({ buffer }, [buffer]);
    return withTimeout(done, () => w.terminate()).finally(() => w.terminate());
  });
}

/** Hex SHA-256 of a CSV header line, cut to 32 characters: the key for its saved column map. */
export async function headerSig(text) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}
