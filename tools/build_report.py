"""Build the Step 1 spending report: report/gastos.html (local, private).

Reads data/ledger.json (from build_ledger.py). All math is done here in Decimal;
the page only draws what it is given. People's names and the text about them come
from data/personal_rules.json (tools/personal.py), "report" section.
"""
import json
import re
import sys
from collections import Counter, defaultdict
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from categorias import GRUPOS, KIND  # noqa: E402
from personal import PERSONAL  # noqa: E402

REPORT = PERSONAL.get("report", {})
# Text for the {{P:key}} spots in report_template.html when the personal file has none.
TEXT = {
    "fam_sub": "Per month, per person.",
    "clase_mixed": "Paybacks (mixed)",
    "clase_note": "Paybacks are their own line because each one covers many kinds of things.",
    "fam_note": "",
    "limits_note": "All limits are yours.",
    "own_transfer_note": "Unnamed Transfer365 payments to your own accounts are not counted.",
    **REPORT.get("text", {}),
}
SHOP_NAMES = [(r"spotify", "Spotify"), (r"name-?cheap", "Namecheap"), (r"hostinger", "Hostinger"),
              (r"hbomax", "HBO Max"), (r"apple\.com", "Apple (iCloud/App Store)"), (r"cloudflare", "Cloudflare"),
              (r"openai|chatgpt", "OpenAI ChatGPT"), (r"canva", "Canva"), (r"avianca", "Avianca"),
              (r"zelva", "Zelva Rooftop")]
PEOPLE_CATS = {"Apoyo familiar", "Pareja", "Amigos", "Otras personas"} | {
    c for c, _ in GRUPOS.get("Deudas y compartidos", [])}

ROOT = Path.home() / "finanzas"
START = "2025-12-01"
FULL = ["2025-12", "2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08",
        "2026-09", "2026-10"]  # complete months; Nov 2026 is partial
RECENT = ["2026-08", "2026-09", "2026-10"]
STACK = ["Pareja y personas", "Comida", "Deudas y compartidos", "Viajes", "Transporte", "Personal", "Familia"]  # 8th = Otros
MES = {"01": "Ene", "02": "Feb", "03": "Mar", "04": "Abr", "05": "May", "06": "Jun", "07": "Jul", "08": "Ago",
       "09": "Sep", "10": "Oct", "11": "Nov", "12": "Dic"}


def r2(x):
    return float(Decimal(x).quantize(Decimal("0.01"), ROUND_HALF_UP))


def amt(r):
    return Decimal(r["monto"]) if r["tipo"] == "gasto" else -abs(Decimal(r["monto"]))


def shop(name):
    n = re.sub(r"^(Card |P2P a |Transferencia a terceros: )", "", name)
    n = re.sub(r"\s+\S*\d{3,}\S*.*$", "", n)
    n = re.sub(r"\s+(SAN SALVADOR|SANTA ANA|SANTA TECLA|BOGOTA|LONDON|SV|CO|GB|US)\b.*$", "", n, flags=re.I)
    n = re.sub(r"\s*\(.*$", "", n)
    n = re.sub(r"^(DLC |PAYU\*?|UBR\.)", "", n)
    n = re.sub(r"\bUBER.*", "UBER", n, flags=re.I)
    n = re.sub(r"^PEDIDOSYA.*", "PEDIDOSYA", n, flags=re.I)
    n = re.sub(r"^RAPPI.*", "RAPPI", n, flags=re.I)
    n = re.sub(r"^(SELECTOS).*", r"\1", n, flags=re.I)
    n = re.sub(r"^(ANTHROPIC|CLAUDE).*", "ANTHROPIC (Claude)", n, flags=re.I)
    n = re.sub(r"^Retiro (cajero|sin tarjeta).*", "Retiros de efectivo", n)
    n = re.sub(r"^Comisión cajero.*", "Comisiones de cajero", n)
    for rx, name in [*REPORT.get("shop_names", []), *SHOP_NAMES]:
        if re.search(rx, n, re.I):
            return name
    return n.strip()[:40] or name[:40]


def main():
    L = [r for r in json.loads((ROOT / "data" / "ledger.json").read_text()) if r["fecha"] >= START]
    sp = [r for r in L if r["tipo"] in ("gasto", "abono")]
    months = sorted({r["fecha"][:7] for r in sp})
    last_day = max(r["fecha"] for r in L)

    by_mg = defaultdict(lambda: defaultdict(Decimal))
    by_cat = defaultdict(Decimal)
    n_cat = Counter()
    for r in sp:
        g = r["grupo"] if r["grupo"] in STACK else "Otros"
        by_mg[r["fecha"][:7]][g] += amt(r)
        by_cat[r["categoria"]] += amt(r)
        n_cat[r["categoria"]] += r["tipo"] == "gasto"
    total = sum(by_cat.values())
    full_total = sum(sum(by_mg[m].values()) for m in FULL)
    income = defaultdict(Decimal)
    nequi = defaultdict(Decimal)
    for r in L:
        if r["tipo"] == "ingreso":
            income[r["fecha"][:7]] += Decimal(r["monto"])
        if r["tipo"] == "interno" and "Nequi" in r["comercio"]:
            nequi[r["fecha"][:7]] += Decimal(r["monto"])

    monthly = [{"m": m, "label": MES[m[5:]] + " " + m[2:4], "partial": m not in FULL,
                "vals": {g: r2(by_mg[m][g]) for g in STACK + ["Otros"]},
                "total": r2(sum(by_mg[m].values())), "ingreso": r2(income[m]), "nequi": r2(nequi[m])}
               for m in months]

    group_of = {c: g for g, cs in GRUPOS.items() for c, _ in cs}
    cats = [{"cat": c, "grupo": group_of.get(c, ""), "clase": KIND.get(c, "?"), "total": r2(v),
             "mes": r2(v / len(FULL)), "n": n_cat[c]} for c, v in sorted(by_cat.items(), key=lambda x: -x[1]) if v > 0]

    shops = defaultdict(lambda: [Decimal(0), 0, set(), defaultdict(Decimal)])
    for r in sp:
        k = shop(r["comercio"])
        shops[k][0] += amt(r)
        shops[k][1] += r["tipo"] == "gasto"
        shops[k][2].add(r["fecha"][:7])
        shops[k][3][r["categoria"]] += amt(r)
    top = [{"shop": k, "total": r2(v[0]), "n": v[1], "meses": len(v[2]), "cat": max(v[3], key=v[3].get)}
           for k, v in sorted(shops.items(), key=lambda x: -x[1][0])[:20]]

    subs = defaultdict(lambda: [Decimal(0), set(), 0])
    for r in sp:
        if r["categoria"] in ("Suscripciones", "Software e IA", "Hosting y dominios") and r["tipo"] == "gasto":
            k = shop(r["comercio"])
            subs[k][0] += amt(r)
            subs[k][1].add(r["fecha"][:7])
            subs[k][2] += 1
    subs_l = [{"shop": k, "total": r2(v[0]), "meses": len(v[1]), "n": v[2],
               "ultimo": max(v[1]), "mes": r2(v[0] / max(len(v[1]), 1))}
              for k, v in sorted(subs.items(), key=lambda x: -x[1][0])]

    # Family and people, per month
    def person(r):
        c = r["comercio"].lower()
        for key, label in REPORT.get("people", []):
            if key in c:
                return label
        return "Otros"
    fam = defaultdict(lambda: defaultdict(Decimal))
    for r in sp:
        if r["categoria"] in PEOPLE_CATS:
            fam[person(r)][r["fecha"][:7]] += amt(r)
    fam_l = [{"who": w, "total": r2(sum(v.values())), "vals": {m: r2(v[m]) for m in months}}
             for w, v in sorted(fam.items(), key=lambda x: -sum(x[1].values()))]

    clase = defaultdict(Decimal)
    for r in sp:
        clase[r["clase"] or "?"] += amt(r)

    def avg(cat_names, ms):
        s = sum(amt(r) for r in sp if r["categoria"] in cat_names and r["fecha"][:7] in ms)
        return s / len(ms)

    def count(cat_names, ms):
        return sum(1 for r in sp if r["categoria"] in cat_names and r["fecha"][:7] in ms and r["tipo"] == "gasto")

    deliv = avg({"Delivery"}, FULL)
    uber = avg({"Uber, taxi y bus"}, FULL)
    snack = avg({"Café y snacks"}, FULL)
    rest = avg({"Restaurantes y comida rápida"}, FULL)
    partner = REPORT.get("partner", "Pareja")
    wise_months = sorted({m for m, v in fam[partner].items() if v})
    partner_avg = sum(fam[partner].values(), Decimal(0)) / max(len(wise_months), 1)
    cash = by_cat["Retiros sin detalle"]
    fees = by_cat["Comisiones e intereses"]
    cuts = [
        {"t": "Delivery: order half as often",
         "d": f"{count({'Delivery'}, FULL)} orders in 11 months (PedidosYa, Rappi), about ${r2(deliv):.0f} a month. "
              "Half as many orders saves about the amount on the right.", "ahorro": r2(deliv / 2)},
        {"t": "Coffee, snacks and store stops: set a weekly cap",
         "d": f"{count({'Café y snacks'}, FULL)} small buys, about ${r2(snack):.0f} a month. A $20 a week cap "
              "(about $87 a month) saves the amount on the right.", "ahorro": max(r2(snack - Decimal(87)), 0)},
        {"t": "Uber: fewer short rides",
         "d": f"{count({'Uber, taxi y bus'}, FULL)} rides and holds, about ${r2(uber):.0f} a month. "
              "Cutting one in four saves the amount on the right.", "ahorro": r2(uber / 4)},
        {"t": "Restaurants: two fewer meals out a month",
         "d": f"About ${r2(rest):.0f} a month in restaurants and fast food.", "ahorro": 25.0},
        {"t": f"{partner}: $300 a month at most (your decision)",
         "d": f"Wise transfers averaged about ${r2(partner_avg):.0f} a month over {len(wise_months)} months. "
              "Capping at $300 saves the amount on the right, which more than covers raising "
              f"{REPORT.get('family', 'family help')} to $150 each.",
         "ahorro": max(r2(partner_avg - Decimal(300)), 0)},
        {"t": "Cash and ATM fees",
         "d": f"${r2(cash):.0f} withdrawn as cash with no detail, plus ${r2(fees):.0f} in ATM and transfer fees. "
              "Fewer, larger withdrawals cut the fees. Log what the cash buys in the app.",
         "ahorro": r2(fees / len(FULL))},
    ]

    recent_g = defaultdict(Decimal)
    for r in sp:
        if r["fecha"][:7] in RECENT:
            recent_g[r["grupo"]] += amt(r)
    full_g = defaultdict(Decimal)
    for r in sp:
        if r["fecha"][:7] in FULL:
            full_g[r["grupo"]] += amt(r)
    # The owner's limits, Nov 25 2026. Casa = $150 rent share + internet/phone + utilities share (proposed).
    suggest = {"Casa": 200, "Comida": 500, "Transporte": 130, "Salud": 50, "Personal": 100, "Ocio": 80,
               "Trabajo": 75, "Familia": 300, "Viajes": 140, "Finanzas": 10, "Efectivo": 50,
               "Pareja y personas": 300}  # $300 = the cap on the Pareja category
    limits = [{"g": g, "avg11": r2(full_g[g] / len(FULL)), "avg3": r2(recent_g[g] / len(RECENT)),
               "limite": suggest.get(g), "cats": ", ".join(c for c, _ in GRUPOS[g])}
              for g in GRUPOS if g not in ("Por revisar", "Deudas y compartidos")]

    review = [{"fecha": r["fecha"], "monto": r2(amt(r)), "comercio": r["comercio"][:90], "cuenta": r["cuenta"]}
              for r in sp if r["categoria"] == "Por revisar"]

    trip = sum(amt(r) for r in sp if "Viaje Colombia" in r["etiquetas"] or r["grupo"] == "Viajes")

    data = {
        "desde": START, "hasta": last_day, "total": r2(total), "full_avg": r2(full_total / len(FULL)),
        "ingreso": r2(sum(income.values())), "ingreso_avg": r2(sum(income[m] for m in FULL) / len(FULL)),
        "nequi": r2(sum(nequi.values())), "movs": len(sp), "monthly": monthly, "stack": STACK + ["Otros"],
        "cats": cats, "top": top, "subs": subs_l, "fam": fam_l, "months": months,
        "clase": {k: r2(v) for k, v in clase.items()}, "cuts": cuts, "limits": limits, "review": review,
        "review_total": r2(sum(Decimal(str(x["monto"])) for x in review)), "trip": r2(trip),
    }
    for key, who in REPORT.get("person_totals", {}).items():
        data[key] = r2(sum(fam[who].values()))
    html = (ROOT / "tools" / "report_template.html").read_text()
    for key, text in TEXT.items():  # owner's own text, before the data goes in
        html = html.replace("{{P:" + key + "}}", text)
    out = ROOT / "report" / "gastos.html"
    out.write_text(html.replace("/*DATA*/null", json.dumps(data, ensure_ascii=False)))
    print("wrote", out, "| total", data["total"], "| avg/mo", data["full_avg"], "| income", data["ingreso"])
    for c in cuts:
        print("  cut", c["ahorro"], c["t"])


if __name__ == "__main__":
    main()
