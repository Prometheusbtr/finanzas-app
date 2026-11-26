"""Category list and shop rules for Finanzas.

Each category has a kind: E = Esencial, G = Gusto, A = Ahorro.
RULES are checked in order; the first regex that matches the comercio wins.
Anything with no match goes to "Por revisar".
Rules and categories that name people come from data/personal_rules.json (tools/personal.py).
"""
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from personal import PERSONAL  # noqa: E402

GRUPOS = {
    "Casa": [("Alquiler o cuota", "E"), ("Luz, agua y gas", "E"), ("Internet y teléfono", "E"),
             ("Cosas para la casa", "G"), ("Mascotas", "E")],
    "Comida": [("Supermercado", "E"), ("Restaurantes y comida rápida", "G"), ("Café y snacks", "G"),
               ("Delivery", "G")],
    "Transporte": [("Gasolina", "E"), ("Uber, taxi y bus", "E"), ("Carro", "E")],
    "Salud": [("Farmacia", "E"), ("Médico y exámenes", "E"), ("Gimnasio y deporte", "G")],
    "Personal": [("Ropa y zapatos", "G"), ("Barbería y cuidado", "G"), ("Compras varias", "G")],
    "Ocio": [("Salidas y entretenimiento", "G"), ("Suscripciones", "G"), ("Libros y cursos", "G")],
    "Trabajo": [("Software e IA", "E"), ("Hosting y dominios", "E"), ("Publicidad", "E"), ("Equipo", "E")],
    # Familia = only real help to family, not paybacks (owner's decision, Nov 25 2026).
    "Familia": [("Apoyo familiar", "E")],
    "Pareja y personas": [("Pareja", "G"), ("Amigos", "G"), ("Otras personas", "G"), ("Regalos", "G")],
    # Paybacks to specific people. Mixed kind M: the real purchases were of many types.
    # Its categories name people, so they come from the personal rules (added below).
    "Deudas y compartidos": [],
    "Viajes": [("Vuelos", "G"), ("Hospedaje", "G"), ("Gastos en viaje", "G")],
    "Finanzas": [("Comisiones e intereses", "E"), ("Inversión", "A")],
    "Efectivo": [("Retiros sin detalle", "E")],
    "Por revisar": [("Por revisar", "?")],
}
for _g, _cats in PERSONAL.get("groups", {}).items():
    GRUPOS.setdefault(_g, []).extend(tuple(c) for c in _cats)

KIND ={cat: kind for g, cats in GRUPOS.items() for cat, kind in cats}
GROUP_OF = {cat: g for g, cats in GRUPOS.items() for cat, kind in cats}

# (regex on comercio, category). Order matters.
RULES = [
    # People (Agricola transfers carry "name (concept)"). Personal "name (concept)" rules go first.
    *(tuple(r) for r in PERSONAL.get("rules_first", [])),
    (r"\(Pupusas\)|\(Minutas\)", "Café y snacks"),
    (r"\(Botas\)", "Ropa y zapatos"),
    (r"\(Mesa\)", "Cosas para la casa"),
    (r"\(Gym\)", "Gimnasio y deporte"),
    (r"\(Cafe\)", "Café y snacks"),
    # Family, friends and other people: personal rules (who each person is lives in that file too).
    *(tuple(r) for r in PERSONAL.get("rules_people", [])),
    (r"Transfer365 a \? ", "Por revisar"),  # older emails carry no recipient name
    # Viajes
    (r"AVIANCA|COPA AIR|VOLARIS|JETBLUE|SPIRIT|AVIATECA|LATAM|WINGO", "Vuelos"),
    (r"AIRBNB|BOOKING|HOTEL|HOSTAL|HOSTEL", "Hospedaje"),
    (r"MIGRACION|TERMINAL|EXPRESO|BOLIVARIANO", "Gastos en viaje"),
    # Subscriptions before Uber rides
    (r"UBER \*ONE|UBER ONE", "Suscripciones"),
    (r"SPOTIFY|APPLE\.COM|HBOMAX|NETFLIX|YOUTUBEPREMIUM|GOOGLE \*GOOGLE\*ONE|DISNEY|PARAMOUNT", "Suscripciones"),
    (r"UBER|DLC UBER|UBR\.UBER|INDRIVE|DIDI", "Uber, taxi y bus"),
    # Trabajo
    (r"UPWORK|ANTHROPIC|OPENAI|CLAUDE|CHATGPT|CURSOR|GITHUB|CANVA|ADOBE|GOOGLE \*?WORKSPACE|ELEVENLABS", "Software e IA"),
    (r"NAME-?CHEAP|HOSTINGER|GODADDY|CLOUDFLARE|SPACESHIP", "Hosting y dominios"),
    (r"GOOGLE\*ADS|FACEBK|META ADS", "Publicidad"),
    # Comida
    (r"\bPET\b", "Mascotas"),
    (r"PEDIDOSYA|DOMICILIO|HUGO|RAPPI", "Delivery"),
    (r"SELECTOS|WALMART|DESPENSA|MAXI|TIENDAS ARA|EXITO|PRICESMART|\bD1\b|OLIMPICA|"
     r"CARULLA|JUMBO|MERCADO|SUPER", "Supermercado"),
    (r"CAFE|JUAN VALDEZ|DONUT|LLAO LLAO|BAN BAN|STARBUCKS|VENDING|TIENDA PRONTO|PRONTO UNO|NEVERIA|OXXO|TEXACO|FOOD ?MART|\bUNO\b|\bPUMA\b|SHELL|KIOSKO|KIOSCO|BRITT|\bPAN\b|COFFE|"
     r"PASTELERIA|PANADERIA|CREPES|WAFFLES|HELAD|POSTJ|TRIGOS", "Café y snacks"),
    (r"TACOS|POLLO|LACA ?LACA|PIZZA|BURGER|MC ?DONALD|SUBWAY|"
     r"PUPUSERIA|PAPA JOHNS|RESTAURA|ASADOS|SUSHI|FOGO|COMIDA|"
     r"CANTINA|DENNYS|CHINA WOK|BBQ|COCINA|PARRILLA|KFC|WENDY|DOMINO", "Restaurantes y comida rápida"),
    (r"\bPUB\b|KLUB|\bBAR\b|CINE|CINEMARK|ROOFTOP|DISCOTECA|COCKTA|CERVECER|VINOS|LICOR|IRISH|"
     r"TERMALES", "Salidas y entretenimiento"),
    # Salud
    (r"FCIA|FARMACIA|DROG|REBAJA|CRUZ VERDE", "Farmacia"),
    (r"CLINICA|DENTAL|HOSPITAL|LABORATORIO|MEDIC", "Médico y exámenes"),
    (r"GYM|GIMNASIO", "Gimnasio y deporte"),
    # Casa
    (r"CLARO|TIGO|DIGICEL|MOVISTAR", "Internet y teléfono"),
    (r"HOMECENTER|FREUND|VIDRI|\bEPA\b", "Cosas para la casa"),
    # Personal
    (r"MEGAPACA|PAYLESS|ALMACENES BOMBA|H&?M|HYM|ZARA|SIMAN|BERSHKA|FALABELLA|ARTURO CALLE|KOAJ|STUDIO F|PULL", "Ropa y zapatos"),
    (r"JOYERIA|FLORIST|FLORES", "Regalos"),
    (r"DOLLAR ?CITY|DOLLAR TOUR|RADIO SHACK|AMAZON|TEMU|SHEIN|MERCADOPAGO|MINISO|PRICE ?SMART", "Compras varias"),
    (r"LIBROS", "Libros y cursos"),
    # Efectivo
    (r"^Retiro sin tarjeta", "Retiros sin detalle"),
]

# Merchants that mark a trip abroad (used to tag "Viaje Colombia")
COLOMBIA = re.compile(r"TIENDAS ARA|BOGOTA|MEDELLIN|"
                      r"SANTA MARTA|CARTAGENA|BOLD\*|"
                      r"MIGRACION COL|\bCO$", re.I)
ABROAD = re.compile(r"\bGT$|\bNI$", re.I)


def categorize(comercio):
    for rx, cat in RULES:
        if re.search(rx, comercio, re.I):
            return cat
    # Unknown shop abroad: count it as a trip expense rather than leave it unsorted.
    if COLOMBIA.search(comercio) or ABROAD.search(comercio):
        return "Gastos en viaje"
    return "Por revisar"
