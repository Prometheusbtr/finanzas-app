// "Primeros pasos": the per-person setup checklist (Cuentas owns the table and the card; Importar and Funciones
// own some steps' screens). The ids and their order are a contract between the agents: do not rename them.
export const STEPS = ["home_screen", "accounts", "life", "statements", "savings", "limits", "alerts", "lock", "bac_email"] as const;
export type StepId = (typeof STEPS)[number];
export const STEP_STATES = ["open", "done", "hidden", "waiting"] as const;

/** Steps whose screen exists. alerts is Funciones' #/pasos/alertas (built in Wave 2). */
export const STEP_AVAILABLE: Record<StepId, boolean> = {
  home_screen: true, accounts: true, life: true, statements: true, savings: true, limits: true, alerts: true, lock: true, bac_email: true,
};

/** True once the Gmail capture of BAC emails exists (the lead builds it later). Step 9 shows only then, for BAC users. */
export const BAC_EMAIL_READY = false;

/** "Tu vida": each yes/no question and the starter groups or categories it shows (yes) or archives (no). */
export const LIFE_MAP: Record<string, { groups?: string[]; categories?: string[] }> = {
  rent: { categories: ["Alquiler o cuota"] },
  vehicle: { categories: ["Gasolina", "Carro"] },
  pet: { categories: ["Mascotas"] },
  work: { groups: ["Trabajo"] },
  family: { groups: ["Familia"] },
  // Also tells Funciones' Personas (who owes whom) that she shares costs: the answer is kept with the step.
  shared: { groups: ["Pareja y personas"] },
  travel: { groups: ["Viajes"] },
};

/** Days of data before the card offers limits from her own spending (after Importar's "Esperar un mes"). */
export const LIMITS_AFTER_DAYS = 30;
