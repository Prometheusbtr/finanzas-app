// Background CSV parse, so a 5 MB file never freezes the screen. Gets the file's bytes, returns the table.
import { MAX_CSV_BYTES, parseCsv } from "./csv.js";

self.onmessage = (e) => {
  try {
    const buf = e.data && e.data.buffer;
    if (!(buf instanceof ArrayBuffer)) throw Object.assign(new Error("bad_file"), { code: "bad_file" });
    if (buf.byteLength > MAX_CSV_BYTES) throw Object.assign(new Error("too_big"), { code: "too_big" });
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
    } catch {
      text = new TextDecoder("windows-1252").decode(buf); // older bank exports
    }
    self.postMessage({ ok: true, table: parseCsv(text) });
  } catch (err) {
    self.postMessage({ ok: false, code: (err && err.code) || "bad_file" });
  }
};
