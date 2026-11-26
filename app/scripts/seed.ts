// Turn the Step 1 ledger (~/finanzas/data/ledger.json) into SQL for one user.
// Usage: node scripts/seed.ts ../data/ledger.json ../data/seed.sql [username]
// Safe to run twice: every row has a unique key and INSERT OR IGNORE skips what is already there.
// Run it after scripts/add-user.ts has created the user.
// Categories that name people come from personal_rules.json next to the ledger (data/, out of git).

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DEFAULT_GROUPS, OWNER_LIMITS } from "../src/lib/defaults.ts";
import { merchantKey } from "../src/lib/merchant.ts";
import { parseCents } from "../src/lib/money.ts";
import { seedRowShape } from "../src/lib/seedrow.ts";

type LedgerRow = {
  fecha: string; hora: string; cuenta: string; comercio: string; monto: string; origen: string;
  tipo: string; categoria: string; grupo: string; clase: string; etiquetas: string[];
};

const [, , ledgerPath, outPath, username = "melvin"] = process.argv;
if (!ledgerPath || !outPath) {
  console.error("usage: node scripts/seed.ts <ledger.json> <out.sql> [username]");
  process.exit(1);
}

const q = (v: string | number | null) => (v === null ? "NULL" : typeof v === "number" ? String(v) : `'${v.replace(/'/g, "''")}'`);
const U = `(SELECT id FROM users WHERE username = ${q(username)})`;
const rows: LedgerRow[] = JSON.parse(readFileSync(ledgerPath, "utf8"));
const now = Date.now();
const sql: string[] = [`-- Seed for ${username} from ${ledgerPath}, ${rows.length} rows, built ${new Date(now).toISOString()}`];

// The defaults plus the personal categories (for example paybacks to named people), in the same order.
const personalPath = join(dirname(ledgerPath), "personal_rules.json");
const personal: { groups?: Record<string, [string, string][]> } = existsSync(personalPath)
  ? JSON.parse(readFileSync(personalPath, "utf8"))
  : {};
const groups: { name: string; cats: [string, string][] }[] = DEFAULT_GROUPS.map((g) => ({
  name: g.name,
  cats: [...g.cats, ...(personal.groups?.[g.name] ?? [])],
}));
for (const [name, cats] of Object.entries(personal.groups ?? {})) {
  if (!groups.some((g) => g.name === name)) groups.push({ name, cats });
}

// Groups and categories (the same defaults a new user gets), then the owner's limits where none is set yet.
groups.forEach((g, gi) => {
  sql.push(`INSERT OR IGNORE INTO groups (user_id, name, sort) SELECT id, ${q(g.name)}, ${gi + 1} FROM users WHERE username = ${q(username)};`);
  g.cats.forEach(([name, kind], ci) => {
    sql.push(
      `INSERT OR IGNORE INTO categories (user_id, group_id, name, kind, sort) ` +
        `SELECT u.id, g.id, ${q(name)}, ${q(kind)}, ${ci + 1} FROM users u JOIN groups g ON g.user_id = u.id AND g.name = ${q(g.name)} ` +
        `WHERE u.username = ${q(username)};`,
    );
  });
});
if (username === "melvin") {
  for (const [g, dollars] of Object.entries(OWNER_LIMITS)) {
    sql.push(`UPDATE groups SET limit_cents = ${dollars * 100} WHERE user_id = ${U} AND name = ${q(g)} AND limit_cents IS NULL;`);
  }
}

// Accounts: most used in the last 60 days first, then Efectivo.
const lastDay = rows.reduce((m, r) => (r.fecha > m ? r.fecha : m), "");
const since = new Date(Date.parse(lastDay + "T00:00:00Z") - 60 * 86400000).toISOString().slice(0, 10);
const use = new Map<string, number>();
for (const r of rows) use.set(r.cuenta, (use.get(r.cuenta) ?? 0) + (r.fecha >= since && r.tipo === "gasto" ? 1 : 0));
const accountKind = (name: string) => (/UglyCash/i.test(name) ? "billetera" : /cuenta/i.test(name) ? "cuenta" : "tarjeta");
const accounts = [...use.keys()].sort((a, b) => use.get(b)! - use.get(a)! || a.localeCompare(b));
accounts.push("Efectivo");
accounts.forEach((name, i) => {
  const kind = name === "Efectivo" ? "efectivo" : accountKind(name);
  sql.push(`INSERT OR IGNORE INTO accounts (user_id, name, kind, sort) SELECT id, ${q(name)}, ${q(kind)}, ${i + 1} FROM users WHERE username = ${q(username)};`);
});

// Movements. Identical rows are real (two same coffees on one statement day), so each copy gets its own number.
const known = new Set(groups.flatMap((g) => g.cats.map(([n]) => n)));
const seen = new Map<string, number>();
const votes = new Map<string, Map<string, number>>();
let bad = 0;
let unknownCats = 0;
// Output says only how many rows had a problem and where (row number), never what is in them:
// this script runs inside agent sessions, and ledger rows are private.
const badRows: number[] = [];
for (const [i, raw] of rows.entries()) {
  const cents = parseCents(raw.monto);
  // F48: a bad date, time or type is skipped and counted here, like a bad amount
  const shape = seedRowShape(raw);
  if (cents === null || !shape) {
    bad++;
    badRows.push(i);
    continue;
  }
  const r = { ...raw, ...shape };
  const base = [r.origen, r.cuenta, r.fecha, r.hora, cents, r.comercio].join("|");
  const n = (seen.get(base) ?? 0) + 1;
  seen.set(base, n);
  const cat = r.categoria && known.has(r.categoria) ? r.categoria : null;
  if (r.categoria && !cat) unknownCats++;
  const key = merchantKey(r.comercio);
  if (cat && r.tipo === "gasto" && key) {
    const v = votes.get(key) ?? new Map<string, number>();
    v.set(cat, (v.get(cat) ?? 0) + 1);
    votes.set(key, v);
  }
  const estado = (r.tipo === "gasto" || r.tipo === "abono") && !cat ? "revisar" : "ok";
  sql.push(
    `INSERT INTO movements (user_id, fecha, hora, amount_cents, tipo, comercio, merchant_key, account_id, category_id, ` +
      `tags, nota, origen, estado, raw, dedupe_key, created_at, updated_at) SELECT u.id, ${q(r.fecha)}, ${q(r.hora || null)}, ` +
      `${cents}, ${q(r.tipo)}, ${q(r.comercio)}, ${q(key)}, ` +
      `(SELECT id FROM accounts WHERE user_id = u.id AND name = ${q(r.cuenta)}), ` +
      `${cat ? `(SELECT id FROM categories WHERE user_id = u.id AND name = ${q(cat)})` : "NULL"}, ` +
      `${q(JSON.stringify(r.etiquetas ?? []))}, '', ${q(r.origen)}, ${q(estado)}, ${q(JSON.stringify(r))}, ` +
      `${q(`seed:${base}|${n}`)}, ${now}, ${now} FROM users u WHERE u.username = ${q(username)} ` +
      // a row seeded before is skipped; any other problem (a CHECK) stops the run instead of vanishing
      `ON CONFLICT (user_id, dedupe_key) DO NOTHING;`,
  );
}

// Shop memory: the category each shop got most often. Choices made later in the app are kept.
for (const [key, v] of votes) {
  const [cat] = [...v.entries()].sort((a, b) => b[1] - a[1])[0];
  sql.push(
    `INSERT OR IGNORE INTO merchant_rules (user_id, merchant_key, category_id, updated_at) ` +
      `SELECT u.id, ${q(key)}, c.id, ${now} FROM users u JOIN categories c ON c.user_id = u.id AND c.name = ${q(cat)} ` +
      `WHERE u.username = ${q(username)};`,
  );
}

writeFileSync(outPath, sql.join("\n") + "\n", { mode: 0o600 });
if (bad) console.error(`skipped ${bad} rows with a bad amount, date, time or type (row numbers: ${badRows.slice(0, 20).join(", ")})`);
if (unknownCats) console.error(`${unknownCats} rows had a category this app does not know; left empty for review`);
console.log(`wrote ${outPath}: ${rows.length - bad} movements (rows seeded before are kept as they are), ${accounts.length} accounts, ${votes.size} shop rules, ${bad} skipped`);
