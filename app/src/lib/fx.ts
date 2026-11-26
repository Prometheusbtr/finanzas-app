// Moneda: a movement may keep the amount it had in another currency (a purchase in Colombia, a Wise send). The
// USD value stays in amount_cents and is the only amount any total adds; the original is kept beside it as whole
// cents of its own currency, from a fixed list, never added to anything. No rates from outside: she types the rate
// or the USD value. fx_micros = units of that currency per 1 USD, times 1,000,000 (an integer, no floats).
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { MAX_CENTS } from "./money.ts";

/** The same list as the CHECK in migrations/0005_features.sql. */
export const CURRENCIES = ["COP", "EUR", "MXN", "GTQ", "HNL", "NIO", "CRC", "PEN", "CAD", "GBP", "BRL", "DOP"] as const;
const BIG = 100_000_000_000_000; // 1e14: a trillion pesos and change

export const FxSchema = z.object({
  currency: z.enum(CURRENCIES),
  cents: z.number().int().min(1).max(BIG),
  micros: z.number().int().min(1).max(BIG).nullable().optional(),
  /** Wise: its fee in USD cents, part of the USD amount sent */
  fee_cents: z.number().int().min(0).max(MAX_CENTS).nullable().optional(),
});
export type Fx = z.infer<typeof FxSchema>;

/** The four columns for a movement of `amountCents` USD: [currency, cents, micros, fee]. Without a typed rate the
 * rate is worked out from the two amounts (after the fee), in integers. */
export function fxColumns(fx: Fx | null | undefined, amountCents: number): [string | null, number | null, number | null, number | null] {
  if (!fx) return [null, null, null, null];
  const fee = fx.fee_cents ?? null;
  if (fee != null && fee >= amountCents) throw new HTTPException(400, { message: "invalid:fx.fee_cents" });
  const base = BigInt(amountCents - (fee ?? 0));
  if (base <= 0n) throw new HTTPException(400, { message: "invalid:amount_cents" }); // never divide by zero
  const micros = fx.micros ?? Number((BigInt(fx.cents) * 1_000_000n + base / 2n) / base);
  if (micros < 1 || micros > BIG) throw new HTTPException(400, { message: "invalid:fx.micros" });
  return [fx.currency, fx.cents, micros, fee];
}
