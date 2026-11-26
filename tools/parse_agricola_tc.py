"""Parse a Banco Agricola credit card estado de cuenta PDF into JSON rows.

Checks: the sum of CARGOS minus ABONOS must equal the statement's
"TOTAL TRANSACCIONES T.CRED" line, or the script exits with an error.

Usage: python tools/parse_agricola_tc.py <statement.pdf> [out.json]
"""
import json
import re
import subprocess
import sys
from decimal import Decimal
from pathlib import Path

ROW = re.compile(
    r"(?P<auth>\d{6})\s+(?P<date>\d{2}/\d{2}/\d{4})\s+(?P<concept>.+?)\s{2,}"
    r"(?P<charge>\d[\d,]*\.\d{2})\s+(?P<credit>\d[\d,]*\.\d{2})\s*$"
)
TOTAL = re.compile(r"TOTAL TRANSACCIONES T\.CRED\s+(\d[\d,]*\.\d{2})\s+(\d[\d,]*\.\d{2})")
CUT = re.compile(r"FECHA DE CORTE\s+(\d{2}/\d{2}/\d{4})")
CARD = re.compile(r"XX\d{2}-(\d{4})")


def money(s):
    return Decimal(s.replace(",", ""))


def iso(d):
    dd, mm, yyyy = d.split("/")
    return f"{yyyy}-{mm}-{dd}"


def parse(pdf):
    text = subprocess.run(
        ["pdftotext", "-layout", str(pdf), "-"], capture_output=True, text=True, check=True
    ).stdout
    rows = []
    for line in text.splitlines():
        m = ROW.search(line)
        if not m:
            continue
        charge, credit = money(m["charge"]), money(m["credit"])
        rows.append({
            "fecha": iso(m["date"]),
            "comercio": re.sub(r"\s+", " ", m["concept"]).strip(),
            "monto": str(charge - credit),
            "tipo": "gasto" if charge > 0 else "abono",
            "autorizacion": m["auth"],
        })
    total = TOTAL.search(text)
    if not total:
        raise SystemExit("total line not found: format changed, check the PDF")
    expected = money(total[1]) - money(total[2])
    got = sum(Decimal(r["monto"]) for r in rows)
    if got != expected:
        raise SystemExit(f"MISMATCH: rows sum {got}, statement total {expected}")
    card = CARD.search(text)
    cut = CUT.search(text)
    return {
        "fuente": "agricola_tc",
        "tarjeta": card[1] if card else None,
        "fecha_corte": iso(cut[1]) if cut else None,
        "total": str(expected),
        "filas": len(rows),
        "movimientos": rows,
    }


if __name__ == "__main__":
    result = parse(Path(sys.argv[1]))
    out = json.dumps(result, ensure_ascii=False, indent=1)
    if len(sys.argv) > 2:
        Path(sys.argv[2]).write_text(out)
    print(f"OK {result['filas']} rows, total {result['total']}, card {result['tarjeta']}, corte {result['fecha_corte']}")
