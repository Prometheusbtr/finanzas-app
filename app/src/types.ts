export type User = { id: number; username: string; display_name: string; lang: "es" | "en"; is_owner: boolean };

/** The signed-in session (set by requireUser): its token hash, whether the Face ID lock lets money through,
 * whether this request carries a proof from a check made in the last 5 minutes WITH the method this person must
 * use (fresh), and that proof's time and method (proof), which a session made after a sensitive change keeps. */
export type SessionInfo = {
  hash: string; locked: boolean; fresh: boolean;
  proof: { at: number; method: "passkey" | "password" | "passphrase" } | null;
};

export type AppEnv = { Bindings: Env; Variables: { user: User; session: SessionInfo } };

export const TIPOS = ["gasto", "abono", "ingreso", "interno", "rechazado", "ignorado"] as const;
export type Tipo = (typeof TIPOS)[number];

export type MovementRow = {
  id: number;
  user_id: number;
  fecha: string;
  hora: string | null;
  amount_cents: number;
  tipo: Tipo;
  comercio: string;
  merchant_key: string;
  account_id: number | null;
  category_id: number | null;
  tags: string;
  nota: string;
  origen: string;
  estado: "ok" | "revisar";
  raw: string | null;
  dedupe_key: string;
  created_at: number;
  updated_at: number;
  // Funciones (Wave 2): the amount in another currency (amount_cents stays the USD value every total uses)
  orig_currency?: string | null;
  orig_cents?: number | null;
  fx_micros?: number | null;
  fee_cents?: number | null;
};

/** What the browser gets for one movement. */
export function publicMovement(m: MovementRow) {
  let tags: string[] = [];
  try {
    tags = JSON.parse(m.tags);
  } catch {
    tags = [];
  }
  return {
    id: m.id, fecha: m.fecha, hora: m.hora, amount_cents: m.amount_cents, tipo: m.tipo,
    comercio: m.comercio, account_id: m.account_id, category_id: m.category_id, tags,
    nota: m.nota, origen: m.origen, estado: m.estado, raw: m.raw,
    fx: m.orig_currency && m.orig_cents ? { currency: m.orig_currency, cents: m.orig_cents, micros: m.fx_micros ?? null, fee_cents: m.fee_cents ?? null } : null,
  };
}
