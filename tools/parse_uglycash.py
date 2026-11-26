"""Parse UglyCash monthly summary PDFs into JSON.

Only final lines with a signed amount are kept; "[AUTH $x]" holds are skipped.
Check per month: sum of + lines == Credits, sum of - lines == Debits, and
start balance + credits - debits + rewards == end balance. Exits on mismatch.

Usage: python tools/parse_uglycash.py <pdf>... (writes data/parsed/uglycash_YYYY-MM.json)
"""
import json
import re
import subprocess
import sys
from decimal import Decimal
from pathlib import Path

OUT = Path.home() / "finanzas" / "data" / "parsed"
ROW = re.compile(r"^\s+(\d{2})/(\d{2})/(\d{4})\s{2,}(.+?)\s{2,}([+-])\$([\d,]+\.\d{2})\s*$")
ZERO = re.compile(r"^\s+\d{2}/\d{2}/\d{4}\s{2,}.+?\s{2,}0\.00\s*$")
SUM = {
    "start": re.compile(r"Balance on \d+/1\s+\$([\d,]+\.\d{2})"),
    "credits": re.compile(r"Credits\s+\+\$([\d,]+\.\d{2})"),
    "debits": re.compile(r"Debits\s+-\$([\d,]+\.\d{2})"),
    "rewards": re.compile(r"Rewards earned\s+\+\$([\d,]+\.\d{2})"),
    "end": re.compile(r"Balance on \d+/\d{2}\s+\$([\d,]+\.\d{2})"),
}


def d(s):
    return Decimal(s.replace(",", ""))


def parse(pdf):
    text = subprocess.run(["pdftotext", "-layout", str(pdf), "-"], capture_output=True, text=True,
                          check=True).stdout
    summ = {}
    for k, rx in SUM.items():
        m = rx.search(text)
        summ[k] = d(m[1]) if m else Decimal(0)
    rows = []
    for line in text.splitlines():
        m = ROW.match(line)
        if not m:
            continue
        mm, dd, yyyy, desc, sign, amt = m.groups()
        ref = re.search(r"\s(?=[a-z]*\d)([a-z0-9]{8})$", desc)
        rows.append({
            "fecha": f"{yyyy}-{mm}-{dd}",
            "descripcion": re.sub(r"\s+", " ", desc[:ref.start()] if ref else desc).strip(),
            "ref": ref[1] if ref else "",
            "monto": str(d(amt) if sign == "-" else -d(amt)),  # positive = money out
            "signo": sign,
        })
    plus = sum(-Decimal(r["monto"]) for r in rows if r["signo"] == "+")
    minus = sum(Decimal(r["monto"]) for r in rows if r["signo"] == "-")
    tol = Decimal("0.02")  # UglyCash rounds sub-cent amounts in its totals
    ok_c = abs(plus - summ["credits"]) <= tol
    ok_d = abs(minus - summ["debits"]) <= tol
    ok_b = abs(summ["start"] + summ["credits"] - summ["debits"] + summ["rewards"] - summ["end"]) <= tol
    return {
        "fuente": "uglycash", "archivo": Path(pdf).name,
        "resumen": {k: str(v) for k, v in summ.items()},
        "suma_creditos": str(plus), "suma_debitos": str(minus),
        "cuadra": {"creditos": ok_c, "debitos": ok_d, "saldo": ok_b},
        "movimientos": rows,
    }


if __name__ == "__main__":
    bad = 0
    for p in sys.argv[1:]:
        r = parse(p)
        month = re.search(r"(\d{4}-\d{2})", Path(p).name)[1]
        (OUT / f"uglycash_{month}.json").write_text(json.dumps(r, ensure_ascii=False, indent=1))
        c = r["cuadra"]
        flag = "OK " if all(c.values()) else "BAD"
        bad += not all(c.values())
        print(f"{flag} {month} rows {len(r['movimientos']):>3} | credits {r['suma_creditos']:>9} vs "
              f"{r['resumen']['credits']:>9} | debits {r['suma_debitos']:>9} vs {r['resumen']['debits']:>9} "
              f"| balance {c['saldo']}")
    sys.exit(1 if bad else 0)
