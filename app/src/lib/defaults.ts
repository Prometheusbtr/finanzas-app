// Starting groups and categories for a new user. Same list as ~/finanzas/tools/categorias.py
// (approved Nov 25 2026). Kind: E Esencial, G Gusto, A Ahorro, M Mixto.
// No real people's names here: categories that name people live in data/personal_rules.json.

export type Kind = "E" | "G" | "A" | "M";

export const DEFAULT_GROUPS: { name: string; cats: [string, Kind][] }[] = [
  { name: "Casa", cats: [["Alquiler o cuota", "E"], ["Luz, agua y gas", "E"], ["Internet y teléfono", "E"], ["Cosas para la casa", "G"], ["Mascotas", "E"]] },
  { name: "Comida", cats: [["Supermercado", "E"], ["Restaurantes y comida rápida", "G"], ["Café y snacks", "G"], ["Delivery", "G"]] },
  { name: "Transporte", cats: [["Gasolina", "E"], ["Uber, taxi y bus", "E"], ["Carro", "E"]] },
  { name: "Salud", cats: [["Farmacia", "E"], ["Médico y exámenes", "E"], ["Gimnasio y deporte", "G"]] },
  { name: "Personal", cats: [["Ropa y zapatos", "G"], ["Barbería y cuidado", "G"], ["Compras varias", "G"]] },
  { name: "Ocio", cats: [["Salidas y entretenimiento", "G"], ["Suscripciones", "G"], ["Libros y cursos", "G"]] },
  { name: "Trabajo", cats: [["Software e IA", "E"], ["Hosting y dominios", "E"], ["Publicidad", "E"], ["Equipo", "E"]] },
  { name: "Familia", cats: [["Apoyo familiar", "E"]] },
  { name: "Pareja y personas", cats: [["Pareja", "G"], ["Amigos", "G"], ["Otras personas", "G"], ["Regalos", "G"]] },
  // Paybacks to specific people. Its categories name people, so scripts/seed.ts adds them
  // from data/personal_rules.json ("groups"). New users skip this group (PERSONAL_GROUPS).
  { name: "Deudas y compartidos", cats: [] },
  { name: "Viajes", cats: [["Vuelos", "G"], ["Hospedaje", "G"], ["Gastos en viaje", "G"]] },
  { name: "Finanzas", cats: [["Comisiones e intereses", "E"], ["Inversión", "A"]] },
  { name: "Efectivo", cats: [["Retiros sin detalle", "E"]] },
];

// Group names that only make sense for one person (their own people). New users skip them.
export const PERSONAL_GROUPS = new Set(["Deudas y compartidos"]);

// Example monthly limits per group in dollars. scripts/seed.ts gives them to the owner's groups.
export const OWNER_LIMITS: Record<string, number> = {
  Casa: 150, Comida: 400, Transporte: 120, Salud: 60, Personal: 80, Ocio: 60, Trabajo: 40,
  Familia: 100, "Pareja y personas": 100, Viajes: 100, Finanzas: 10, Efectivo: 50,
};
