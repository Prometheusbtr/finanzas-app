"""Combine parsed emails and statements into one ledger: data/ledger.json.

Rules:
- Statement rows win over purchase alerts for the dates a statement covers
  (alerts show Uber holds; the statement shows the final charge).
- Transfers between the owner's own accounts are "interno" and never counted.
- Rejected operations are kept as "rechazado" and never counted.
- Every row gets a category from tools/categorias.py; unknowns are "Por revisar".
- Names, payment handles and account labels come from data/personal_rules.json (tools/personal.py).
"""
import copy
import json
import re
import sys
from decimal import Decimal
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from categorias import COLOMBIA, GROUP_OF, KIND, categorize  # noqa: E402
from personal import PERSONAL  # noqa: E402

ROOT = Path.home() / "finanzas"
PARSED = ROOT / "data" / "parsed"
OWN_NAMES = re.compile(PERSONAL["own_names"], re.I) if PERSONAL.get("own_names") else None
UGLY_ACCOUNT = PERSONAL.get("accounts", {}).get("uglycash", "UglyCash")
UGLY_P2P = PERSONAL.get("uglycash_p2p", [])  # [prefix, label]: P2P sends to known people
UGLY_RULES = PERSONAL.get("uglycash_rules", [])  # {"match": regex, "set": fields}, first match wins


def clean_shop(name):
    name = re.sub(r"\*\s*PENDING|help\.uber\.c\w*|\s{2,}", " ", name)
    return re.sub(r"\s+", " ", name).strip()


def ugly_name(desc):
    n = re.sub(r"^Card ", "", desc)
    n = re.sub(r"\s*/\s*/?", " ", n)
    return re.sub(r"\s+", " ", n).strip()


def uglycash_rows():
    """UglyCash: card buys, cash, transfers and income. Owner's decisions (Nov 25 2026):
    Nequi is the owner's own account (interno). Known people and payees (P2P, PayPal,
    Wise) are matched by the personal rules."""
    out = []
    for p in sorted(PARSED.glob("uglycash_*.json")):
        movs = json.loads(p.read_text())["movimientos"]
        # cash withdrawals: lines without "Card " that are not known transfer types
        cash = [m for m in movs if m["signo"] == "-" and not m["descripcion"].startswith("Card ")
                and not re.match(r"(P2P|International ACH|Sobrecito)", m["descripcion"])]
        biggest = {}
        for m in cash:
            biggest[m["ref"]] = max(biggest.get(m["ref"], Decimal(0)), Decimal(m["monto"]))
        for m in movs:
            desc, amt = m["descripcion"], Decimal(m["monto"])
            row = {"fecha": m["fecha"], "hora": "", "cuenta": UGLY_ACCOUNT, "comercio": ugly_name(desc),
                   "monto": str(abs(amt)), "origen": "estado UglyCash", "tipo": "gasto"}
            if m["signo"] == "+":
                if re.match(r"Payvalida Deposit", desc):
                    row.update(tipo="interno", comercio="Recarga desde Agricola (Payvalida)")
                elif re.match(r"Virtual Deposit", desc):
                    row.update(tipo="ingreso", comercio=desc.split(" ")[0] + " " + desc.split(" ")[1])
                elif re.match(r"(RSR Conversion)", desc):
                    row.update(tipo="ingreso", comercio="Recompensas UglyCash")
                elif re.match(r"Sobrecito", desc):
                    row.update(tipo="interno")
                else:  # refunds and card credits reduce spending
                    row.update(tipo="abono", comercio=ugly_name(re.sub(r"^REFUND from ", "", desc)))
            elif re.search(r"NEQUI", desc, re.I):
                row.update(tipo="interno", comercio="A mi Nequi")
            elif re.match(r"Sobrecito", desc):
                row.update(tipo="interno")
            elif p2p := next((label for prefix, label in UGLY_P2P if desc.startswith(prefix)), None):
                row.update(comercio=p2p)
            elif desc.startswith("P2P"):
                row.update(comercio=desc.replace("P2P Transfer to ", "P2P a "))
            elif desc.startswith("International ACH"):
                row.update(comercio="International ACH Transfer", categoria="Por revisar")
            elif m in cash:
                is_fee = amt < biggest[m["ref"]]
                place = re.sub(r"^ATM Withdrawal from ", "", desc)
                row.update(comercio=("Comisión cajero " if is_fee else "Retiro cajero ") + place,
                           categoria="Comisiones e intereses" if is_fee else "Retiros sin detalle")
            else:
                rule = next((r for r in UGLY_RULES if re.search(r["match"], desc)), None)
                if rule:
                    row.update(copy.deepcopy(rule["set"]))
            out.append(row)
    return out


def main():
    emails = json.loads((PARSED / "emails.json").read_text())["movimientos"]
    statements = [json.loads(p.read_text()) for p in sorted(PARSED.glob("agricola_tc*.json"))]

    rows = []
    covered = []  # (card, start, end) date windows covered by a statement
    for st in statements:
        dates = [m["fecha"] for m in st["movimientos"]]
        start, end = min(dates), st["fecha_corte"]
        covered.append((st["tarjeta"], start, end))
        for m in st["movimientos"]:
            rows.append({
                "fecha": m["fecha"], "hora": "", "cuenta": f"Agricola TC {st['tarjeta']}",
                "comercio": m["comercio"], "monto": m["monto"], "origen": "estado de cuenta",
                "tipo": "gasto" if Decimal(m["monto"]) > 0 else "abono",
            })

    for e in emails:
        src, day = e["tipo_fuente"], e["fecha"][:10]
        if e["monto"] is None and e["estado"] == "Aprobada":
            continue  # e.g. phone top-up email with no amount
        if src == "agricola_compra" and any(
                e["cuenta"].endswith(card) and start <= day <= end for card, start, end in covered):
            continue  # statement already has it
        tipo = "gasto"
        if src == "agricola_t365" and e["comercio"].startswith("Transfer365 a ? "):
            tipo = "interno"  # unnamed: Agricola's "Abono a Cuenta" twin shows the owner's own name at BAC
        elif re.search(r"Payvalida", e["comercio"]):
            tipo = "interno"  # Agricola -> Payvalida -> UglyCash top-up ($2 fee each)
        elif e["estado"] != "Aprobada":
            tipo = "rechazado"
        elif src == "bac_transfer" or (src == "agricola_t365" and OWN_NAMES
                                       and OWN_NAMES.search(e.get("beneficiario", ""))):
            tipo = "interno"
        rows.append({
            "fecha": day, "hora": e["fecha"][11:16], "cuenta": e["cuenta"],
            "comercio": clean_shop(e["comercio"]), "monto": e["monto"],
            "origen": {"bac_compra": "correo BAC", "agricola_compra": "correo Agricola (sin estado aun)"}.get(
                src, "correo " + src),
            "tipo": tipo,
        })
        if rows[-1]["monto"] is None:
            rows[-1]["monto"] = "0.00"

    rows += uglycash_rows()

    for r in rows:
        if r.get("categoria"):
            cat = r["categoria"]
        else:
            cat = categorize(r["comercio"]) if r["tipo"] in ("gasto", "abono") else ""
        if cat == "Por revisar" and r["fecha"] <= "2026-11-25":
            # Owner's decision, Nov 25 2026: disregard the old unsorted ones (unknown people, ACH, small shops).
            r["tipo"], cat = "ignorado", ""
        r["categoria"] = cat
        r["grupo"] = GROUP_OF.get(cat, "")
        r["clase"] = KIND.get(cat, "")
        if not r.get("etiquetas"):
            r["etiquetas"] = ["Viaje Colombia"] if COLOMBIA.search(r["comercio"]) else []

    rows.sort(key=lambda r: (r["fecha"], r["hora"]))
    (ROOT / "data" / "ledger.json").write_text(json.dumps(rows, ensure_ascii=False, indent=1))

    from collections import Counter, defaultdict
    print("rows", len(rows), dict(Counter(r["tipo"] for r in rows)))
    pend = defaultdict(lambda: [0, Decimal(0)])
    for r in rows:
        if r["tipo"] == "gasto" and r["categoria"] == "Por revisar":
            k = re.sub(r"\s+\S*\d{3,}\S*.*$", "", r["comercio"])[:40]
            pend[k][0] += 1
            pend[k][1] += Decimal(r["monto"])
    total = sum(v[1] for v in pend.values())
    print(f"por revisar: {sum(v[0] for v in pend.values())} rows = ${total}")
    for k, v in sorted(pend.items(), key=lambda x: -x[1][1])[:60]:
        print(f"  {v[1]:>8} {v[0]:>3} {k}")


if __name__ == "__main__":
    main()
