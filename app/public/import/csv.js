// General CSV reader, pure functions: text -> table -> rows, with column guessing. The parse runs in a
// background worker (csv-worker.js); the column choice is remembered per bank file layout on the server.
// Row cents follow the PDF readers: positive = money out, negative = money in.

export const MAX_CSV_BYTES = 5 * 1024 * 1024;
export const MAX_CSV_ROWS = 2000;

function fail(code) {
  const e = new Error(code);
  e.code = code;
  return e;
}

/** RFC 4180 style: quotes, doubled quotes, new lines inside quotes; the delimiter is guessed (, ; tab). */
export function parseCsv(text, { maxRows = MAX_CSV_ROWS } = {}) {
  let s = String(text);
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  const first = s.slice(0, s.indexOf("\n") === -1 ? s.length : s.indexOf("\n"));
  const count = (ch) => first.split(ch).length - 1;
  const delimiter = [",", ";", "\t"].sort((a, b) => count(b) - count(a))[0];
  const out = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"' && cell === "") quoted = true;
    else if (ch === delimiter) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && s[i + 1] === "\n") i++;
      row.push(cell);
      cell = "";
      if (row.some((c) => c.trim() !== "")) out.push(row);
      row = [];
      if (out.length > maxRows + 1) throw fail("too_many_rows");
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== "")) out.push(row);
  if (out.length > maxRows + 1) throw fail("too_many_rows");
  const header = (out.shift() || []).map((h) => h.trim());
  return { header, rows: out.map((r) => r.map((c) => c.trim())), delimiter };
}

const norm = (h) => String(h).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** A stable text for the header line; the screen hashes it to remember the column choice for this bank. */
export function headerText(header) {
  return header.map(norm).join("|");
}

const NAMES = {
  fecha: /^(fecha( de)?( (transaccion|operacion|movimiento|compra))?|date|transaction date|posted date|posting date|fecha valor)$/,
  comercio: /^(descripcion|concepto|comercio|detalle|description|merchant|payee|narrative|details|referencia|movimiento)$/,
  monto: /^(monto|importe|valor|amount|total|monto usd|amount usd)$/,
  cargo: /^(cargo|cargos|debito|debitos|debit|debits|retiro|retiros|withdrawal|withdrawals|salida|salidas)$/,
  abono: /^(abono|abonos|credito|creditos|credit|credits|deposito|depositos|deposit|deposits|entrada|entradas)$/,
  saldo: /^(saldo|balance|saldo disponible|running balance)$/,
};

/** Amount text -> cents (sign kept). Handles $, thousands marks, (12.34), 12,34 and trailing minus. */
export function amountCents(text) {
  let t = String(text).replace(/\s|\$|USD|US\$/gi, "");
  if (!t) return null;
  let neg = false;
  if (/^\(.*\)$/.test(t)) {
    neg = true;
    t = t.slice(1, -1);
  }
  if (t.startsWith("-")) {
    neg = !neg;
    t = t.slice(1);
  } else if (t.endsWith("-")) {
    neg = !neg;
    t = t.slice(0, -1);
  } else if (t.startsWith("+")) t = t.slice(1);
  const lastDot = t.lastIndexOf(".");
  const lastComma = t.lastIndexOf(",");
  let whole;
  let frac = "";
  if (lastComma > lastDot && t.length - lastComma - 1 <= 2) {
    whole = t.slice(0, lastComma).replace(/\./g, "");
    frac = t.slice(lastComma + 1);
  } else if (lastDot >= 0) {
    whole = t.slice(0, lastDot).replace(/,/g, "");
    frac = t.slice(lastDot + 1);
  } else whole = t.replace(/,/g, "");
  if (!/^\d+$/.test(whole || "0") || !/^\d{0,2}$/.test(frac)) return null;
  const c = Number(whole || "0") * 100 + Number((frac + "00").slice(0, 2));
  return Number.isSafeInteger(c) ? (neg ? -c : c) : null;
}

/** Date text -> "YYYY-MM-DD" for one order (dmy, mdy, ymd). Two-digit years are 20xx. */
export function dateOf(text, order) {
  const m = /^(\d{1,4})[\/.\-](\d{1,2})[\/.\-](\d{1,4})/.exec(String(text).trim());
  if (!m) return null;
  let [, a, b, c] = m;
  let y;
  let mo;
  let d;
  if (a.length === 4) [y, mo, d] = [a, b, c];
  else if (order === "mdy") [mo, d, y] = [a, b, c];
  else [d, mo, y] = [a, b, c];
  if (order === "ymd" && a.length !== 4) return null;
  if (y.length === 2) y = "20" + y;
  if (y.length !== 4) return null;
  const s = `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
  const t = new Date(s + "T00:00:00Z");
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === s ? s : null;
}

/** Guess which column is which. Returns a map the user can change: column numbers or null. */
export function guessMap(header, rows) {
  const h = header.map(norm);
  const find = (rx) => {
    const i = h.findIndex((x) => rx.test(x));
    return i < 0 ? null : i;
  };
  const map = { fecha: find(NAMES.fecha), comercio: find(NAMES.comercio), monto: find(NAMES.monto), cargo: find(NAMES.cargo), abono: find(NAMES.abono), saldo: find(NAMES.saldo), order: "dmy", sign: "out_negative" };
  const sample = rows.slice(0, 200);
  // No header names known: look at the values.
  if (map.fecha == null) {
    const i = h.findIndex((_, k) => sample.length && sample.every((r) => dateOf(r[k] || "", "dmy") || dateOf(r[k] || "", "mdy")));
    map.fecha = i < 0 ? null : i;
  }
  if (map.monto == null && map.cargo == null && map.abono == null) {
    const i = h.findIndex((_, k) => k !== map.fecha && k !== map.saldo && sample.length && sample.every((r) => amountCents(r[k] || "") != null));
    map.monto = i < 0 ? null : i;
  }
  if (map.comercio == null) {
    let best = null;
    let len = 0;
    h.forEach((_, k) => {
      if ([map.fecha, map.monto, map.cargo, map.abono, map.saldo].includes(k)) return;
      const l = sample.reduce((s, r) => s + (r[k] || "").length, 0);
      if (l > len) [best, len] = [k, l];
    });
    map.comercio = best;
  }
  // Date order: the one that reads every row; day first when both do (El Salvador writes 31/12/2026).
  if (map.fecha != null) {
    const all = (o) => sample.every((r) => dateOf(r[map.fecha] || "", o));
    map.order = all("dmy") ? "dmy" : all("mdy") ? "mdy" : all("ymd") ? "ymd" : "dmy";
  }
  // Sign of a single amount column: most lines of an export are spending, so the more common sign is money out.
  // A bank account shows spending as negative (pay is the odd positive line); a card shows purchases as positive
  // (the payment is the odd negative line). A tie reads spending as negative.
  if (map.monto != null) {
    let neg = 0;
    let pos = 0;
    for (const r of sample) {
      const v = amountCents(r[map.monto] || "") ?? 0;
      if (v < 0) neg++;
      else if (v > 0) pos++;
    }
    map.sign = neg >= pos && neg > 0 ? "out_negative" : "out_positive";
  }
  return map;
}

/** Table + column map -> rows and the check. Rows that cannot be read are counted, never guessed. */
export function readCsv(table, map) {
  const rows = [];
  const bad = [];
  const balances = [];
  table.rows.forEach((r, i) => {
    const fecha = map.fecha == null ? null : dateOf(r[map.fecha] || "", map.order);
    let cents = null;
    if (map.monto != null) {
      const v = amountCents(r[map.monto] || "");
      if (v != null) cents = map.sign === "out_negative" ? -v : v;
    } else {
      // An empty cell is 0; a cell with text that is not an amount makes the line unreadable (never a silent 0).
      const cell = (k) => {
        const v = k == null ? "" : String(r[k] || "").trim();
        return v ? amountCents(v) : 0;
      };
      const out = cell(map.cargo);
      const inn = cell(map.abono);
      cents = out == null || inn == null ? null : Math.abs(out) - Math.abs(inn);
    }
    if (!fecha || cents == null) {
      bad.push(i + 2); // line number in the file (the header is line 1)
      return;
    }
    if (cents === 0) return;
    rows.push({ fecha, comercio: String(map.comercio == null ? "" : r[map.comercio] || "").replace(/\s+/g, " ").trim(), cents, tipo: null, ref: "", line: i + 2 });
    if (map.saldo != null) balances.push({ line: i + 2, saldo: amountCents(r[map.saldo] || ""), cents, fecha });
  });
  const ds = rows.map((x) => x.fecha).sort();
  const period = ds.length ? { start: ds[0], end: ds[ds.length - 1] } : null;
  let check = balanceCheck(balances);
  // Lines that could not be read are missing money: the balance can never be called right then (F02).
  if (bad.length && check.ok === true) check = { ok: null, label: "bad_lines" };
  return { kind: "csv", bank: "CSV", card: null, cut: period ? period.end : null, period, rows, bad, check };
}

/**
 * With a balance column: each balance must follow from the one before it. Reports the first line that breaks.
 * One balance compares nothing, so it proves nothing: ok null.
 */
function balanceCheck(list) {
  if (list.length < 2 || list.some((b) => b.saldo == null)) return { ok: null, label: "no_balance" };
  const run = (arr) => {
    for (let i = 1; i < arr.length; i++) if (arr[i - 1].saldo - arr[i].cents !== arr[i].saldo) return arr[i].line;
    return null;
  };
  const up = run(list); // oldest first
  const down = run([...list].reverse()); // newest first
  if (up == null || down == null) {
    const ordered = up == null ? list : [...list].reverse();
    const got = ordered.slice(1).reduce((s, b) => s - b.cents, 0);
    return { ok: true, label: "balance", expected: ordered[ordered.length - 1].saldo - ordered[0].saldo, got, diff: 0 };
  }
  // Neither order works: report the break in the file's own date order.
  const newestFirst = list[0].fecha > list[list.length - 1].fecha;
  return { ok: false, label: "balance", line: newestFirst ? down : up, expected: null, got: null, diff: null };
}
