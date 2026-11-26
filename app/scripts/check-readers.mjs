// Check the statement readers (public/import/parse.js) on real files, printing counts, dates and totals only:
// never a row, a shop name or a card number. Runs the vendored pdf.js in Node 22.
//
//   node scripts/check-readers.mjs <statement.pdf>... [--expect <python output.json>]... [--ledger <ledger.json>]
//
// --expect: a tools/parse_*.py output for the same statement; rows and totals must match to the cent.
// --ledger: for BAC, compare with the BAC email rows of the same card (account name ends with the card's
//           last 4) inside the statement period: counts and totals, and how many pair up (same amount, 3 days).
// Exit code 1 when a statement does not add up or does not match its Python output.
import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pub = join(here, "..", "public");
await import(pathToFileURL(join(pub, "import", "compat.js")).href);
const pdfjs = await import(pathToFileURL(join(pub, "vendor", "pdfjs-6.5.438", "pdf.min.mjs")).href);
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(join(pub, "vendor", "pdfjs-6.5.438", "pdf.worker.min.mjs")).href;
const { readStatement } = await import(pathToFileURL(join(pub, "import", "parse.js")).href);
const { pdfItems } = await import(pathToFileURL(join(pub, "import", "pdf-items.js")).href);

const args = process.argv.slice(2);
const files = [];
const expects = [];
let ledger = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--expect") expects.push(JSON.parse(readFileSync(args[++i], "utf8")));
  else if (args[i] === "--ledger") ledger = JSON.parse(readFileSync(args[++i], "utf8"));
  else files.push(args[i]);
}

const usd = (c) => (c < 0 ? "-" : "") + "$" + (Math.abs(c) / 100).toFixed(2);
const cents = (s) => Math.round(Number(s) * 100);
let bad = 0;
const bacs = [];
for (const f of files) {
  const data = new Uint8Array(readFileSync(f));
  const task = pdfjs.getDocument({ data, useWasm: false, enableXfa: false, disableFontFace: true, useSystemFonts: false, verbosity: 0 });
  const doc = await task.promise;
  const pages = await pdfItems(doc);
  const st = readStatement(pages);
  const name = basename(f);
  if (!st) {
    console.log(`${name}: no reader knows this file`);
    bad++;
    continue;
  }
  const out = st.rows.filter((r) => r.cents > 0);
  const inn = st.rows.filter((r) => r.cents < 0);
  const dates = st.rows.map((r) => r.fecha).sort();
  const c = st.check;
  console.log(`${name}: ${st.kind}, ${doc.numPages} pages, ${st.rows.length} rows, ${dates[0] ?? "-"} to ${dates.at(-1) ?? "-"}, period ${st.period?.start} to ${st.period?.end}`);
  console.log(`  out ${out.length} = ${usd(out.reduce((s, r) => s + r.cents, 0))}, in ${inn.length} = ${usd(-inn.reduce((s, r) => s + r.cents, 0))}, internal ${st.rows.filter((r) => r.tipo === "interno").length}`);
  console.log(`  check (${c.label}): ${c.ok ? "OK" : "DOES NOT ADD UP"}, statement ${c.expected == null ? "-" : usd(c.expected)}, rows ${usd(c.got)}${c.diff ? `, diff ${usd(c.diff)}` : ""}${c.parts ? " " + JSON.stringify(c.parts) : ""}${c.credit ? `, credit with no row ${usd(c.credit)}` : ""}`);
  if (!c.ok) bad++;

  for (const e of expects) {
    if (st.kind === "agricola_tc" && e.fuente === "agricola_tc" && e.fecha_corte === st.cut) {
      const same = e.movimientos.length === st.rows.length && cents(e.total) === st.rows.reduce((s, r) => s + r.cents, 0);
      const pyOut = e.movimientos.filter((m) => cents(m.monto) > 0).reduce((s, m) => s + cents(m.monto), 0);
      console.log(`  vs Python: rows ${e.movimientos.length} vs ${st.rows.length}, total ${usd(cents(e.total))} vs ${usd(c.got)}, charges ${usd(pyOut)} vs ${usd(out.reduce((s, r) => s + r.cents, 0))}: ${same ? "SAME" : "DIFFERENT"}`);
      if (!same) bad++;
    }
    if (st.kind === "uglycash" && e.fuente === "uglycash" && e.archivo === name) {
      const pyPlus = cents(e.suma_creditos);
      const pyMinus = cents(e.suma_debitos);
      const jsPlus = -inn.reduce((s, r) => s + r.cents, 0);
      const jsMinus = out.reduce((s, r) => s + r.cents, 0);
      const pyOk = Object.values(e.cuadra).every(Boolean);
      const same = e.movimientos.length === st.rows.length && pyPlus === jsPlus && pyMinus === jsMinus && pyOk === c.ok;
      console.log(`  vs Python: rows ${e.movimientos.length} vs ${st.rows.length}, credits ${usd(pyPlus)} vs ${usd(jsPlus)}, debits ${usd(pyMinus)} vs ${usd(jsMinus)}, adds up ${pyOk} vs ${c.ok}: ${same ? "SAME" : "DIFFERENT"}`);
      if (!same) bad++;
    }
  }

  if (ledger && st.kind === "bac_tc" && st.card && st.period) bacs.push(st);
  if (ledger && st.kind === "bac_tc" && st.card && st.period) {
    const { start, end } = st.period;
    const mail = ledger.filter((r) => r.origen === "correo BAC" && String(r.cuenta).endsWith(st.card) && r.fecha >= start && r.fecha <= end);
    const mailGasto = mail.filter((r) => r.tipo === "gasto");
    const charges = out.map((r) => ({ ...r, used: false }));
    let paired = 0;
    let pairedCents = 0;
    const left = [];
    for (const m of mail) {
      const a = cents(m.monto);
      const hit = charges.filter((r) => !r.used && r.cents === a && Math.abs(Date.parse(r.fecha) - Date.parse(m.fecha)) <= 3 * 86400000)
        .sort((x, y) => Math.abs(Date.parse(x.fecha) - Date.parse(m.fecha)) - Math.abs(Date.parse(y.fecha) - Date.parse(m.fecha)))[0];
      if (hit) {
        hit.used = true;
        paired++;
        pairedCents += a;
      } else left.push(m);
    }
    const extra = charges.filter((r) => !r.used);
    console.log(`  vs BAC emails for the same card, ${start} to ${end}: emails ${mail.length} (${mailGasto.length} gasto) = ${usd(mail.reduce((s, r) => s + cents(r.monto), 0))}; statement charges ${out.length} = ${usd(out.reduce((s, r) => s + r.cents, 0))}`);
    console.log(`  paired ${paired} = ${usd(pairedCents)}; emails not on the statement ${left.length} = ${usd(left.reduce((s, r) => s + cents(r.monto), 0))} (tipos ${JSON.stringify(left.reduce((a, r) => ((a[r.tipo] = (a[r.tipo] || 0) + 1), a), {}))}); statement charges with no email ${extra.length} = ${usd(extra.reduce((s, r) => s + r.cents, 0))}`);
    const near = (d) => d <= shift(start, 3) || d >= shift(end, -3);
    console.log(`  of those: emails within 3 days of the period edges ${left.filter((m) => near(m.fecha)).length}, statement charges within 3 days of the edges ${extra.filter((r) => near(r.fecha)).length}`);
  }
  await task.destroy();
}
// All BAC statements of one card together against the emails of the whole span: no edge effects.
const cards = [...new Set(bacs.map((b) => b.card))];
for (const card of cards) {
  const list = bacs.filter((b) => b.card === card);
  const start = list.map((b) => b.period.start).sort()[0];
  const end = list.map((b) => b.period.end).sort().at(-1);
  const charges = list.flatMap((b) => b.rows.filter((r) => r.cents > 0).map((r) => ({ ...r, fee: b.summary.fees, used: false })));
  const mail = ledger.filter((r) => r.origen === "correo BAC" && String(r.cuenta).endsWith(card) && r.fecha >= start && r.fecha <= end).map((m) => ({ ...m, c: cents(m.monto), used: false }));
  const days = (a, b) => Math.abs(Date.parse(a) - Date.parse(b)) / 86400000;
  let paired = 0;
  for (const m of mail) {
    const hit = charges.filter((r) => !r.used && r.cents === m.c && days(r.fecha, m.fecha) <= 3).sort((x, y) => days(x.fecha, m.fecha) - days(y.fecha, m.fecha))[0];
    if (hit) { hit.used = m.used = true; paired++; }
  }
  // left-overs that are the same purchase with a changed amount (tips, fuel holds): same date +-1, within 25%
  let changed = 0;
  let changedDiff = 0;
  for (const m of mail.filter((x) => !x.used)) {
    const hit = charges.find((r) => !r.used && days(r.fecha, m.fecha) <= 1 && Math.abs(r.cents - m.c) <= Math.max(100, m.c * 0.25));
    if (hit) { hit.used = m.used = true; changed++; changedDiff += hit.cents - m.c; }
  }
  const lm = mail.filter((x) => !x.used);
  const lc = charges.filter((x) => !x.used);
  const fees = lc.filter((r) => r.fee > 0 && r.cents === r.fee); // the statement's own COMISIONES amount
  const sumc = (a, k) => a.reduce((s, r) => s + r[k], 0);
  console.log(`BAC card ${cards.indexOf(card) + 1}, ${list.length} statements together, ${start} to ${end}: statement charges ${charges.length} = ${usd(sumc(charges, "cents"))}, BAC emails ${mail.length} = ${usd(sumc(mail, "c"))}`);
  console.log(`  same amount within 3 days ${paired}; same purchase with a changed amount ${changed} (net ${usd(changedDiff)}); fee rows with no email ${fees.length} = ${usd(sumc(fees, "cents"))}`);
  console.log(`  left: emails with no statement row ${lm.length} = ${usd(sumc(lm, "c"))} (tipos ${JSON.stringify(lm.reduce((a, r) => ((a[r.tipo] = (a[r.tipo] || 0) + 1), a), {}))}), statement charges with no email ${lc.length - fees.length} = ${usd(sumc(lc, "cents") - sumc(fees, "cents"))}`);
  const near = (d) => days(d, start) <= 3 || days(d, end) <= 3;
  console.log(`  of the left-overs, within 3 days of the span's edges: emails ${lm.filter((m) => near(m.fecha)).length}, charges ${lc.filter((r) => !fees.includes(r) && near(r.fecha)).length}`);
}
function shift(d, n) {
  return new Date(Date.parse(d + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
}
process.exit(bad ? 1 : 0);
