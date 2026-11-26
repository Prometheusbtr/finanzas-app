// Statement readers, pure functions only (no pdf.js, no page): positioned text items -> lines -> rows plus the
// statement's own totals. pdf.js (import/pdf.js) turns a file into items; everything here can be tested with
// made-up items. Money is whole cents. Row cents are signed: positive = money out (a charge), negative = money in.
// Nothing here goes into HTML: the screen escapes every text with esc().

// ---------- items -> lines ----------

const AMOUNT_RX = /^[+-]?\$?\s*\d[\d,]*\.\d{2}$/;

/**
 * Rebuild text lines from positioned items, the way `pdftotext -layout` lays them out: items on the same
 * baseline join into one line, and the space between two items grows with the gap, so columns stay apart
 * by two or more spaces. pages: [{ items: [{ s, x, y, w, h }] }], y grows upward (PDF space).
 * Returns [{ page, y, text, cells: [{ s, x, end }] }] in reading order.
 */
export function itemsToLines(pages) {
  const out = [];
  pages.forEach((p, pi) => {
    const items = (p.items || []).filter((i) => typeof i.s === "string" && i.s.trim() !== "" && Number.isFinite(i.x) && Number.isFinite(i.y));
    items.sort((a, b) => b.y - a.y || a.x - b.x);
    const lines = [];
    for (const it of items) {
      const h = it.h > 0 ? it.h : 8;
      const last = lines[lines.length - 1];
      if (last && Math.abs(last.y - it.y) <= Math.max(1.2, Math.min(last.h, h) * 0.45)) last.items.push(it);
      else lines.push({ y: it.y, h, items: [it] });
    }
    for (const l of lines) {
      l.items.sort((a, b) => a.x - b.x);
      let chars = 0;
      let width = 0;
      for (const i of l.items) {
        chars += i.s.length;
        width += Math.max(0, i.w || 0);
      }
      const cw = chars && width ? width / chars : 5; // average character width on this line
      let text = " ".repeat(Math.max(1, Math.round(l.items[0].x / Math.max(cw, 1) / 2)));
      let end = null;
      let prev = null;
      const cells = [];
      for (const i of l.items) {
        const w = Math.max(0, i.w || 0) || i.s.length * cw;
        if (end != null) {
          const gap = i.x - end;
          let n = gap <= cw * 0.15 ? 0 : Math.max(1, Math.round(gap / cw));
          // An amount is always its own column: keep at least two spaces before and after it.
          if (n && n < 2 && (AMOUNT_RX.test(i.s.trim()) || (prev && AMOUNT_RX.test(prev.s.trim()))) && gap > cw * 0.3) n = 2;
          text += " ".repeat(Math.min(n, 60));
        }
        text += i.s;
        cells.push({ s: i.s, x: i.x, end: i.x + w });
        end = i.x + w;
        prev = i;
      }
      out.push({ page: pi + 1, y: l.y, text, cells });
    }
  });
  return out;
}

// ---------- small helpers ----------

/** "1,234.56" -> 123456. Only plain dot-decimal bank amounts. */
export function centsOf(s) {
  const m = /^(\d[\d,]*)\.(\d{2})$/.exec(String(s).trim());
  if (!m) return null;
  const whole = Number(m[1].replace(/,/g, ""));
  return Number.isSafeInteger(whole) ? whole * 100 + Number(m[2]) : null;
}
const squash = (s) => String(s).replace(/\s+/g, " ").trim();

/** Long digit runs (card, account and reference numbers) keep only their last 4: "12345678" -> "••••5678".
 * The server does the same again (src/lib/importing.ts maskDigits): keep the two the same. */
export function maskDigits(s) {
  return String(s)
    .replace(/\b\d{4}(?:[ -]\d{4}){2,3}\b/g, (m) => "••••" + m.replace(/\D/g, "").slice(-4))
    .replace(/\d(?:-?\d){6,}/g, (m) => "••••" + m.replace(/\D/g, "").slice(-4))
    .replace(/\d(?:[ -]?\d){11,}/g, (m) => "••••" + m.replace(/\D/g, "").slice(-4));
}

const MONTHS = { ENE: 1, FEB: 2, MAR: 3, ABR: 4, MAY: 5, JUN: 6, JUL: 7, AGO: 8, SEP: 9, SET: 9, OCT: 10, NOV: 11, DIC: 12 };
const pad = (n) => String(n).padStart(2, "0");
export function isoDate(y, m, d) {
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31 && y >= 2000 && y <= 2100)) return null;
  const s = `${y}-${pad(m)}-${pad(d)}`;
  const t = new Date(s + "T00:00:00Z");
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === s ? s : null;
}
export function shiftDays(fecha, days) {
  return new Date(Date.parse(fecha + "T00:00:00Z") + days * 86400000).toISOString().slice(0, 10);
}
function lastDayOf(ym) {
  const [y, m] = ym.split("-").map(Number);
  return `${ym}-${pad(new Date(Date.UTC(y, m, 0)).getUTCDate())}`;
}
function rangeOf(rows) {
  const ds = rows.map((r) => r.fecha).sort();
  return ds.length ? { start: ds[0], end: ds[ds.length - 1] } : null;
}

/** The statement check every reader returns: closing minus opening (or the statement's own total) against the rows. */
function check(label, expected, got, tolerance = 0) {
  if (expected == null) return { ok: false, label, expected: null, got, diff: null };
  const diff = got - expected;
  return { ok: Math.abs(diff) <= tolerance, label, expected, got, diff };
}

// Card payments and moves between one's own accounts are "interno": never spending.
const CARD_PAYMENT = /\bSU PAGO\b|\bPAGO\s+(?:RECIBIDO|EN LINEA|DE TARJETA|TARJETA|TC|BANCA|ELECTRONICO|GRACIAS|POR\b)|^PAGO\b|\bABONO A TARJETA\b|\bGRACIAS POR SU PAGO\b/i;

// ---------- Banco Agrícola credit card (port of tools/parse_agricola_tc.py) ----------

const AGR_ROW = /(\d{6})\s+(\d{2})\/(\d{2})\/(\d{4})\s+(.+?)\s{2,}(\d[\d,]*\.\d{2})\s+(\d[\d,]*\.\d{2})\s*$/;
const AGR_TOTAL = /TOTAL TRANSACCIONES T\.CRED\s+(\d[\d,]*\.\d{2})\s+(\d[\d,]*\.\d{2})/;
const AGR_CUT = /FECHA DE CORTE\s+(\d{2})\/(\d{2})\/(\d{4})/;
const AGR_CARD = /XX\d{2}-(\d{4})/;

export function readAgricola(lines) {
  const rows = [];
  let total = null;
  let cut = null;
  let card = null;
  for (const l of lines) {
    const t = l.text;
    const m = AGR_ROW.exec(t);
    if (m) {
      const charge = centsOf(m[6]);
      const credit = centsOf(m[7]);
      const fecha = isoDate(Number(m[4]), Number(m[3]), Number(m[2]));
      if (fecha && charge != null && credit != null) {
        const comercio = squash(m[5]);
        const cents = charge - credit;
        rows.push({ fecha, comercio, cents, tipo: cents < 0 && CARD_PAYMENT.test(comercio) ? "interno" : null, ref: m[1] });
      }
    }
    // The side column shares lines with the rows (the cut date sits on the first row's line).
    const tt = AGR_TOTAL.exec(t);
    if (tt && total == null) total = centsOf(tt[1]) - centsOf(tt[2]);
    const c = AGR_CUT.exec(t);
    if (c && !cut) cut = isoDate(Number(c[3]), Number(c[2]), Number(c[1]));
    const k = AGR_CARD.exec(t);
    if (k && !card) card = k[1];
  }
  const got = rows.reduce((s, r) => s + r.cents, 0);
  const r = rangeOf(rows);
  return {
    kind: "agricola_tc", bank: "Agrícola", card, cut,
    period: r ? { start: r.start, end: cut && cut > r.end ? cut : r.end } : null,
    rows,
    check: check("total", total, got),
  };
}

// ---------- UglyCash monthly summary (port of tools/parse_uglycash.py) ----------

const UG_ROW = /^\s+(\d{2})\/(\d{2})\/(\d{4})\s{2,}(.+?)\s{2,}([+-])\$([\d,]+\.\d{2})\s*$/;
const UG_SUM = {
  start: /Balance on (\d+)\/1\s+\$([\d,]+\.\d{2})/,
  credits: /Credits\s+\+\$([\d,]+\.\d{2})/,
  debits: /Debits\s+-\$([\d,]+\.\d{2})/,
  rewards: /Rewards earned\s+\+\$([\d,]+\.\d{2})/,
  end: /Balance on (\d+)\/(\d{2})\s+\$([\d,]+\.\d{2})/,
};
const UG_TOLERANCE = 2; // cents: UglyCash rounds sub-cent amounts in its totals

function uglyTipo(sign, desc) {
  if (sign === "+") {
    if (/^Payvalida Deposit/.test(desc)) return "interno"; // a top-up from one's own bank account
    if (/^Virtual Deposit|^RSR Conversion/.test(desc)) return "ingreso";
    if (/^Sobrecito/.test(desc)) return "interno";
    return null; // refunds and card credits: abono
  }
  if (/^Sobrecito/.test(desc)) return "interno"; // money into one's own savings envelope
  return null;
}
function uglyName(desc) {
  return squash(desc.replace(/^REFUND from /, "").replace(/^Card /, "").replace(/\*\s*PENDING/g, " ").replace(/\s*\/\s*\/?/g, " "));
}

export function readUglycash(lines) {
  const text = lines.map((l) => l.text).join("\n");
  const sum = {};
  let startMonth = null;
  for (const [k, rx] of Object.entries(UG_SUM)) {
    const m = rx.exec(text);
    if (k === "start" && m) startMonth = Number(m[1]);
    sum[k] = m ? centsOf(m[k === "start" ? 2 : k === "end" ? 3 : 1]) : 0;
    if (!m && (k === "start" || k === "end")) sum.missing = true;
  }
  const rows = [];
  let plus = 0;
  let minus = 0;
  for (const l of lines) {
    const m = UG_ROW.exec(l.text);
    if (!m) continue;
    const [, mm, dd, yyyy, rawDesc, sign, amt] = m;
    const fecha = isoDate(Number(yyyy), Number(mm), Number(dd));
    const a = centsOf(amt);
    if (!fecha || a == null) continue;
    const ref = /\s(?=[a-z]*\d)([a-z0-9]{8})$/.exec(rawDesc); // a reference has a digit: "Incoming transfer" keeps its word
    const desc = squash(ref ? rawDesc.slice(0, ref.index) : rawDesc);
    if (sign === "+") plus += a;
    else minus += a;
    rows.push({ fecha, comercio: uglyName(desc), cents: sign === "-" ? a : -a, tipo: uglyTipo(sign, desc), ref: ref ? ref[1] : "" });
  }
  const okCredits = Math.abs(plus - sum.credits) <= UG_TOLERANCE;
  const okDebits = Math.abs(minus - sum.debits) <= UG_TOLERANCE;
  const balance = sum.start + sum.credits - sum.debits + sum.rewards - sum.end;
  // The month: from the "Balance on M/1" line, with the year of the rows.
  let period = null;
  const years = rows.map((r) => r.fecha.slice(0, 4)).sort();
  if (startMonth && years.length) {
    const ym = `${years[Math.floor(years.length / 2)]}-${pad(startMonth)}`;
    period = { start: ym + "-01", end: lastDayOf(ym) };
  } else if (rows.length) period = rangeOf(rows);
  const got = rows.reduce((s, r) => s - r.cents, 0); // money in minus money out
  const ok = okCredits && okDebits && Math.abs(balance) <= UG_TOLERANCE && Math.abs(got - (sum.end - sum.start - sum.rewards)) <= UG_TOLERANCE * 2;
  const { missing, ...summary } = sum;
  // No "Balance on" line: there is no balance to check against (F50), so the check says so instead of agreeing.
  if (missing) return { kind: "uglycash", bank: "UglyCash", card: null, cut: period ? period.end : null, period, rows, summary: { ...summary, plus, minus }, check: { ok: null, label: "no_balance" } };
  return {
    kind: "uglycash", bank: "UglyCash", card: null, cut: period ? period.end : null, period, rows,
    summary: { ...summary, plus, minus },
    check: {
      ok, label: "balance", expected: sum.end - sum.start - sum.rewards, got, diff: got - (sum.end - sum.start - sum.rewards),
      parts: { credits: okCredits, debits: okDebits, balance: Math.abs(balance) <= UG_TOLERANCE },
    },
  };
}

// ---------- BAC Credomatic credit card ----------

// A row: "OCT/16  17/10 12345678 V123 SHOP NAME ...   $  12.34" with the amount under CARGOS or ABONOS.
const BAC_DATE = /^([A-Z]{3})\/(\d{2})$/;
const BAC_LABELS = {
  previous: /^SALDO ANTERIOR$/,
  purchases: /^COMPRAS Y CUOTAS$/,
  extra: /^CUOTA\(S\) EXTRAFINANCIAMIENTO$/,
  fees: /^COMISIONES$/,
  surcharges: /^RECARGOS$/,
  payments: /^PAGOS Y DEPOSITOS$/,
  interest: /^INTERESES SOBRE SALDO$/,
  closing: /^SALDO DE CONTADO$/,
  bonus: /^INTERESES BONIFICABLES?$/,
};

/** Pairs of "LABEL $ 1,234.56" on one line, left to right. */
function labelAmounts(text) {
  const out = [];
  const rx = /([A-Z][A-Z()\/.]*(?: [A-Z()\/.]+)*)\s+\$\s*(-?[\d,]+\.\d{2})/g;
  let m;
  while ((m = rx.exec(squash(text)))) out.push([m[1], m[2].startsWith("-") ? -centsOf(m[2].slice(1)) : centsOf(m[2])]);
  return out;
}

export function readBac(lines) {
  let cut = null;
  let card = null;
  let days = null;
  let colCargos = null;
  let colAbonos = null;
  const sum = {};
  for (const l of lines) {
    const t = squash(l.text);
    const c = /FECHA DE CORTE (\d{2})\/(\d{2})\/(\d{2,4})/.exec(t);
    if (c && !cut) cut = isoDate(Number(c[3].length === 2 ? "20" + c[3] : c[3]), Number(c[2]), Number(c[1]));
    const k = /\b\d{4}-\d{2}XX-XXXX-(\d{4})\b/.exec(t);
    if (k && !card) card = k[1];
    const d = /\bDIAS (\d{1,3})\b/.exec(t);
    if (d && days == null) days = Number(d[1]);
    if (colCargos == null && /\bCARGOS\b/.test(t) && /\bABONOS\b/.test(t) && /CONCEPTO/.test(t)) {
      for (const cell of l.cells) {
        if (/^\s*CARGOS\s*$/.test(cell.s)) colCargos = cell.end;
        if (/^\s*ABONOS\s*$/.test(cell.s)) colAbonos = cell.end;
      }
    }
    for (const [label, cents] of labelAmounts(t)) {
      for (const [key, rx] of Object.entries(BAC_LABELS)) {
        // "SALDO DE CONTADO" shows twice (account box and movements box) with the same value; keep the first.
        if (rx.test(label) && sum[key] === undefined) sum[key] = cents;
      }
    }
  }
  const rows = [];
  const cutYear = cut ? Number(cut.slice(0, 4)) : null;
  const cutMonth = cut ? Number(cut.slice(5, 7)) : null;
  // Which column an amount sits in: its right edge nearest the CARGOS or ABONOS header's right edge.
  const isCredit = (cell) => colCargos != null && colAbonos != null && Math.abs(cell.end - colAbonos) < Math.abs(cell.end - colCargos);
  let total = null; // the statement's own "TOTAL ...:" line under the rows: { cargos, abonos }
  for (const l of lines) {
    const cells = l.cells;
    if (!cells.length) continue;
    if (/^TOTAL\b/.test(cells[0].s.trim()) || /^TOTAL \.+:?/.test(squash(l.text))) {
      if (/^TOTAL \.+:/.test(squash(l.text))) {
        total = { cargos: 0, abonos: 0 };
        for (const cell of cells) {
          const v = /^\d[\d,]*\.\d{2}$/.test(cell.s.trim()) ? centsOf(cell.s.trim()) : null;
          if (v != null) total[isCredit(cell) ? "abonos" : "cargos"] += v;
        }
      }
      continue;
    }
    const dm = BAC_DATE.exec(cells[0].s.trim());
    if (!dm || !(dm[1] in MONTHS)) continue;
    // the amount: the last cell that is a plain amount, with a "$" cell before it
    let ai = -1;
    for (let i = cells.length - 1; i > 0; i--) {
      if (/^\d[\d,]*\.\d{2}$/.test(cells[i].s.trim())) {
        ai = i;
        break;
      }
    }
    if (ai < 0) continue;
    const cents = centsOf(cells[ai].s.trim());
    if (cents == null) continue;
    const month = MONTHS[dm[1]];
    const day = Number(dm[2]);
    const year = cutYear == null ? null : month > cutMonth ? cutYear - 1 : cutYear;
    const fecha = year ? isoDate(year, month, day) : null;
    if (!fecha) continue;
    const credit = isCredit(cells[ai]);
    // Concept: what comes after the posting date, the reference and its short code, before the "$".
    const parts = cells.slice(1, ai).map((x) => x.s.trim()).filter((s) => s && s !== "$");
    let concept = parts.join(" ");
    concept = concept.replace(/^\d{2}\/\d{2}\s+\S+(?:\s+[A-Z]\d{3})?\s*/, "");
    concept = squash(concept);
    const signed = credit ? -cents : cents;
    rows.push({ fecha, comercio: concept, cents: signed, tipo: credit && CARD_PAYMENT.test(concept) ? "interno" : null, ref: "" });
  }
  const got = rows.reduce((s, r) => s + r.cents, 0);
  const cargos = rows.filter((x) => x.cents > 0).reduce((s, x) => s + x.cents, 0);
  const abonos = -rows.filter((x) => x.cents < 0).reduce((s, x) => s + x.cents, 0);
  const have = (...k) => k.every((x) => typeof sum[x] === "number");
  // BAC adds last month's "intereses bonificables" to SALDO ANTERIOR and, when the balance was paid in full,
  // takes them off again inside PAGOS Y DEPOSITOS without a row. That credit is PAGOS minus the ABONOS rows' total.
  const credit = total && have("payments") ? sum.payments - total.abonos : 0;
  const expected = have("closing", "previous") ? sum.closing - sum.previous + credit : null;
  const summaryOk = have("previous", "purchases", "fees", "payments", "closing")
    ? sum.previous + sum.purchases + (sum.extra || 0) + sum.fees + (sum.surcharges || 0) + (sum.interest || 0) - sum.payments === sum.closing
    : null;
  const totalOk = total ? total.cargos === cargos && total.abonos === abonos : null;
  const chk = check("balance", expected, got);
  chk.ok = chk.ok && totalOk !== false && summaryOk !== false;
  chk.parts = { total_line: totalOk, summary: summaryOk };
  if (credit) chk.credit = credit;
  const r = rangeOf(rows);
  let period = null;
  if (cut) period = { start: days ? shiftDays(cut, -(days - 1)) : r ? r.start : cut, end: cut };
  else if (r) period = r;
  if (period && r && r.start < period.start) period.start = r.start;
  return { kind: "bac_tc", bank: "BAC", card, cut, period, rows, summary: { ...sum, total }, check: chk };
}

// ---------- which reader ----------

/** Pick the reader from the statement's own words. Returns null when no reader knows the file. */
export function detect(lines) {
  const text = lines.slice(0, 400).map((l) => l.text).join("\n");
  if (/TOTAL TRANSACCIONES T\.CRED/.test(text) || (/AGR[IÍ]COLA/i.test(text) && /FECHA DE CORTE/.test(text))) return "agricola_tc";
  if (/UglyCash/i.test(text) || (/Balance on \d+\/1\b/.test(text) && /Rewards earned/.test(text))) return "uglycash";
  if (/CREDOMATIC/i.test(text) && /RESUMEN DE MOVIMIENTOS/.test(text)) return "bac_tc";
  return null;
}

export function readStatement(pages) {
  const lines = itemsToLines(pages);
  const kind = detect(lines);
  if (kind === "agricola_tc") return readAgricola(lines);
  if (kind === "uglycash") return readUglycash(lines);
  if (kind === "bac_tc") return readBac(lines);
  return null;
}
