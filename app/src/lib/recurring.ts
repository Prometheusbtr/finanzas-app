// Fixed payments ("pagos fijos"): the same shop, a similar amount, at a regular gap. Pure functions, no
// database, so Funciones can reuse them. Input rows are spending rows (tipo gasto) with whole cents.

export type SpendRow = { merchant_key: string; comercio: string; fecha: string; amount_cents: number };

export type Recurring = {
  merchant_key: string;
  comercio: string;        // the shop name as it last appeared
  amount_cents: number;    // the usual amount (median)
  every_days: 7 | 14 | 30; // weekly, every two weeks or monthly
  count: number;
  last_fecha: string;
  next_fecha: string;      // when the next one is expected
};

const DAY = 86_400_000;
const days = (a: string, b: string) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / DAY);
const addDays = (f: string, n: number) => new Date(Date.parse(f + "T00:00:00Z") + n * DAY).toISOString().slice(0, 10);

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

// Each kind of gap: the days it stands for, how far one gap may drift, and how many payments prove it.
const PERIODS: { every: 7 | 14 | 30; min: number; max: number; drift: number; need: number }[] = [
  { every: 7, min: 5, max: 9, drift: 2, need: 3 },
  { every: 14, min: 12, max: 17, drift: 3, need: 3 },
  { every: 30, min: 26, max: 35, drift: 5, need: 2 },
];

/** Amounts close enough to be "the same payment": within 10% or $1 of the usual; with only two payments, 2% or $0.50. */
function similar(amounts: number[], usual: number): boolean {
  const tight = amounts.length < 3;
  const room = Math.max(tight ? usual * 0.02 : usual * 0.1, tight ? 50 : 100);
  return amounts.every((a) => Math.abs(a - usual) <= room);
}

/** Find fixed payments in a list of spending rows. Biggest first. */
export function findRecurring(rows: SpendRow[]): Recurring[] {
  const byShop = new Map<string, SpendRow[]>();
  for (const r of rows) {
    if (!r.merchant_key || !(r.amount_cents > 0)) continue;
    const list = byShop.get(r.merchant_key) ?? [];
    list.push(r);
    byShop.set(r.merchant_key, list);
  }
  const out: Recurring[] = [];
  for (const [key, list] of byShop) {
    if (list.length < 2) continue;
    list.sort((a, b) => a.fecha.localeCompare(b.fecha) || a.amount_cents - b.amount_cents);
    // Two charges on one day are one visit for the gap (a shop seen several times a day is not a fixed payment).
    const visits: SpendRow[] = [];
    for (const r of list) if (!visits.length || visits[visits.length - 1].fecha !== r.fecha) visits.push(r);
    if (visits.length !== list.length) continue;
    const gaps = visits.slice(1).map((r, i) => days(visits[i].fecha, r.fecha));
    const g = median(gaps);
    const p = PERIODS.find((x) => g >= x.min && g <= x.max);
    if (!p || visits.length < p.need) continue;
    if (!gaps.every((x) => Math.abs(x - g) <= p.drift)) continue;
    const amounts = visits.map((r) => r.amount_cents);
    const usual = median(amounts);
    if (!similar(amounts, usual)) continue;
    const last = visits[visits.length - 1];
    out.push({
      merchant_key: key, comercio: last.comercio, amount_cents: usual, every_days: p.every, count: visits.length,
      last_fecha: last.fecha, next_fecha: addDays(last.fecha, p.every === 30 ? g : p.every),
    });
  }
  return out.sort((a, b) => b.amount_cents - a.amount_cents || a.merchant_key.localeCompare(b.merchant_key));
}

/** What a fixed payment costs in one month. */
export function monthlyCents(r: Pick<Recurring, "amount_cents" | "every_days">): number {
  return r.every_days === 30 ? r.amount_cents : Math.round((r.amount_cents * 365) / 12 / r.every_days);
}
