// Starter shop rules for imported statements, ported from ~/finanzas/tools/categorias.py (RULES).
// Used only after the user's own shop memory (merchant_rules) and only when the user still has a
// category with that exact starter name (src/lib/defaults.ts); otherwise the row goes to Revisar.
// Left out on purpose: the personal rules (data/personal_rules.json), the "name (concept)" transfer
// rules and the other rules that only make sense for the owner's own history.

export const STARTER_RULES: [RegExp, string][] = [
  // Viajes
  [/AVIANCA|COPA AIR|VOLARIS|JETBLUE|SPIRIT|AVIATECA|LATAM|WINGO/i, "Vuelos"],
  [/AIRBNB|BOOKING|HOTEL|HOSTAL|HOSTEL/i, "Hospedaje"],
  [/MIGRACION|TERMINAL|EXPRESO|BOLIVARIANO/i, "Gastos en viaje"],
  // Subscriptions before Uber rides
  [/UBER \*ONE|UBER ONE/i, "Suscripciones"],
  [/SPOTIFY|APPLE\.COM|HBOMAX|NETFLIX|YOUTUBEPREMIUM|GOOGLE \*GOOGLE\*ONE|DISNEY|PARAMOUNT/i, "Suscripciones"],
  [/UBER|DLC UBER|UBR\.UBER|INDRIVE|DIDI/i, "Uber, taxi y bus"],
  // Trabajo
  [/UPWORK|ANTHROPIC|OPENAI|CLAUDE|CHATGPT|CURSOR|GITHUB|CANVA|ADOBE|GOOGLE \*?WORKSPACE|ELEVENLABS/i, "Software e IA"],
  [/NAME-?CHEAP|HOSTINGER|GODADDY|CLOUDFLARE|SPACESHIP/i, "Hosting y dominios"],
  [/GOOGLE\*ADS|FACEBK|META ADS/i, "Publicidad"],
  // Comida
  [/\bPET\b/i, "Mascotas"],
  [/PEDIDOSYA|DOMICILIO|HUGO|RAPPI/i, "Delivery"],
  [/SELECTOS|WALMART|DESPENSA|MAXI|TIENDAS ARA|EXITO|PRICESMART|\bD1\b|OLIMPICA|CARULLA|JUMBO|MERCADO|SUPER/i, "Supermercado"],
  [
    /CAFE|JUAN VALDEZ|DONUT|LLAO LLAO|BAN BAN|STARBUCKS|VENDING|TIENDA PRONTO|PRONTO UNO|NEVERIA|OXXO|TEXACO|FOOD ?MART|\bUNO\b|\bPUMA\b|SHELL|KIOSKO|KIOSCO|BRITT|\bPAN\b|COFFE|PASTELERIA|PANADERIA|CREPES|WAFFLES|HELAD|POSTJ|TRIGOS/i,
    "Café y snacks",
  ],
  [
    /TACOS|POLLO|LACA ?LACA|PIZZA|BURGER|MC ?DONALD|SUBWAY|PUPUSERIA|PAPA JOHNS|RESTAURA|ASADOS|SUSHI|FOGO|COMIDA|CANTINA|DENNYS|CHINA WOK|BBQ|COCINA|PARRILLA|KFC|WENDY|DOMINO/i,
    "Restaurantes y comida rápida",
  ],
  [/\bPUB\b|KLUB|\bBAR\b|CINE|CINEMARK|ROOFTOP|DISCOTECA|COCKTA|CERVECER|VINOS|LICOR|IRISH|TERMALES/i, "Salidas y entretenimiento"],
  // Salud
  [/FCIA|FARMACIA|DROG|REBAJA|CRUZ VERDE/i, "Farmacia"],
  [/CLINICA|DENTAL|HOSPITAL|LABORATORIO|MEDIC/i, "Médico y exámenes"],
  [/GYM|GIMNASIO/i, "Gimnasio y deporte"],
  // Casa
  [/CLARO|TIGO|DIGICEL|MOVISTAR/i, "Internet y teléfono"],
  [/HOMECENTER|FREUND|VIDRI|\bEPA\b/i, "Cosas para la casa"],
  // Personal
  [/MEGAPACA|PAYLESS|ALMACENES BOMBA|H&?M|HYM|ZARA|SIMAN|BERSHKA|FALABELLA|ARTURO CALLE|KOAJ|STUDIO F|PULL/i, "Ropa y zapatos"],
  [/JOYERIA|FLORIST|FLORES/i, "Regalos"],
  [/DOLLAR ?CITY|DOLLAR TOUR|RADIO SHACK|AMAZON|TEMU|SHEIN|MERCADOPAGO|MINISO|PRICE ?SMART/i, "Compras varias"],
  [/LIBROS/i, "Libros y cursos"],
  // Efectivo
  [/^Retiro sin tarjeta/i, "Retiros sin detalle"],
];

// An unknown shop abroad counts as a trip expense rather than staying unsorted.
const ABROAD = /BOGOTA|MEDELLIN|SANTA MARTA|CARTAGENA|BOLD\*|\bCO$|\bGT$|\bNI$/i;

/** The starter category name for a shop, or null. */
export function starterCategory(comercio: string): string | null {
  for (const [rx, cat] of STARTER_RULES) if (rx.test(comercio)) return cat;
  if (ABROAD.test(comercio)) return "Gastos en viaje";
  return null;
}
