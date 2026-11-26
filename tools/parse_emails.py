"""Turn saved bank emails (data/raw/gmail/*.eml) into one list of movements.

Output: data/parsed/emails.json with every movement found, plus a list of
transaction-like emails that could not be parsed (nothing is silently dropped).

Kinds produced:
  bac_compra        BAC card purchase alert (Alerta PRF)
  agricola_compra   Banco Agricola credit card purchase alert
  agricola_t365     Transfer365 sent from Banco Agricola to another bank
  agricola_app      Banca Movil / e-banca operation (amount read from comprobante.pdf if attached)
  agricola_rechazo  Rejected Banco Agricola transaction (never counted)
  bac_retiro        BAC cardless cash withdrawal (internal: bank -> cash)
  bac_transfer      BAC transfer notice
"""
import email
import email.header
import email.utils
import hashlib
import html
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from personal import PERSONAL  # noqa: E402

ROOT = Path.home() / "finanzas"
RAW = ROOT / "data" / "raw" / "gmail"
OUT = ROOT / "data" / "parsed" / "emails.json"
BAC_CUENTA = PERSONAL.get("accounts", {}).get("bac_cuenta", "BAC cuenta")  # label with the real last 4


def subject(m):
    return str(email.header.make_header(email.header.decode_header(m.get("Subject", ""))))


def text_of(m):
    plain = html_part = None
    for part in m.walk():
        if part.get_filename() or part.is_multipart():
            continue
        try:
            payload = part.get_payload(decode=True).decode(part.get_content_charset() or "utf-8", "ignore")
        except Exception:
            continue
        if part.get_content_type() == "text/plain" and plain is None:
            plain = payload
        elif part.get_content_type() == "text/html" and html_part is None:
            html_part = payload
    t = plain or ""
    if html_part and len(t.strip()) < 40:
        x = re.sub(r"(?is)<(script|style).*?</\1>", "", html_part)
        x = re.sub(r"(?i)<br\s*/?>|</(p|div|tr|td|th|li|h\d)>", "\n", x)
        t = html.unescape(re.sub(r"<[^>]+>", " ", x))
    t = t.replace("\xa0", " ").replace("|", "\n").replace("\t", "\n")
    lines = [re.sub(r"\s+", " ", l).strip() for l in t.splitlines()]
    return "\n".join(l for l in lines if l)


def pdf_texts(m):
    out = []
    for part in m.walk():
        fn = part.get_filename() or ""
        if fn.lower().endswith(".pdf"):
            with tempfile.NamedTemporaryFile(suffix=".pdf") as f:
                f.write(part.get_payload(decode=True))
                f.flush()
                r = subprocess.run(["pdftotext", "-layout", f.name, "-"], capture_output=True, text=True)
                out.append(r.stdout)
    return out


def money(s):
    return f"{float(s.replace(',', '')):.2f}"


def dmy(d, t="00:00:00"):
    dd, mm, yyyy = d.split("/")
    t = ":".join(x.zfill(2) for x in t.split(":"))
    return f"{yyyy}-{mm.zfill(2)}-{dd.zfill(2)}T{t}"


NON_MONEY = re.compile(r"viajeros|bloqueo|desbloqueo|modificar usuarios|QR principal|solicitud de producto|favorito", re.I)


def key(*parts):
    return hashlib.sha256("|".join(map(str, parts)).encode()).hexdigest()[:16]


def parse_bac_compra(t):
    card = re.search(r"tarjeta (\w+) terminada en (\d{4})", t)
    m = re.search(r"Comercio\nMonto\n(.+?)\n(?:USD |\$)?([\d,]+\.\d{2})(?: ?(USD|[A-Z]{3}))?\n", t)
    when = re.search(r"Fecha y hora\n(\d{4})/(\d{2})/(\d{2})-(\d{2}:\d{2}:\d{2})", t)
    estado = re.search(r"Estado\n(?:.+\n)?(Aprobada|Rechazada|Denegada|Declinada|Reversada|Anulada)", t, re.I)
    tipo = re.search(r"Tipo de la compra\nEstado\n(.+?)\n", t)
    if not (m and when):
        return None
    y, mo, d, hms = when.groups()
    return {
        "cuenta": f"BAC {card[1].upper()} {card[2]}" if card else "BAC tarjeta",
        "comercio": m[1].strip(),
        "monto": money(m[2]),
        "moneda": m[3] or "USD",
        "fecha": f"{y}-{mo}-{d}T{hms}",
        "estado": (estado[1].capitalize() if estado else "Desconocido"),
        "detalle": tipo[1] if tipo else "",
    }


def parse_agricola_compra(t):
    m = re.search(
        r"tarjeta de cr.dito (\d{4}) ha realizado una (\w+(?: \w+)?) por (USD|[A-Z]{3}) ([\d,]+(?:\.\d{1,2})?) en (.+?)\.\s*Fecha/Hora: (\d{1,2}/\d{2}/\d{4}) (\d{1,2}:\d{1,2}:\d{1,2})",
        t.replace("\n", " "),
    )
    if not m:
        return None
    return {
        "cuenta": f"Agricola TC {m[1]}",
        "comercio": m[5].strip(),
        "monto": money(m[4]),
        "moneda": m[3],
        "fecha": dmy(m[6], m[7]),
        "estado": "Aprobada",
        "detalle": m[2].upper(),
    }


def parse_t365(t):
    monto = re.search(r"Monto: ([\d,]+(?:\.\d+)?)", t)
    when = re.search(r"Fecha y hora: (\d{4})(\d{2})(\d{2}) (\d{2})(\d{2})(\d{2})", t)
    dest = re.search(r"Instituci.n destino: (.+)", t)
    benef = re.search(r"Nombre del beneficiario: (.+)", t)
    if not (monto and when):
        return None
    y, mo, d, hh, mi, ss = when.groups()
    return {
        "cuenta": "Agricola cuenta",
        "comercio": f"Transfer365 a {benef[1].strip() if benef else '?'} ({dest[1].strip() if dest else '?'})",
        "monto": money(monto[1]),
        "moneda": "USD",
        "fecha": f"{y}-{mo}-{d}T{hh}:{mi}:{ss}",
        "estado": "Aprobada",
        "detalle": "transferencia",
        "beneficiario": benef[1].strip() if benef else "",
        "banco_destino": dest[1].strip() if dest else "",
    }


def parse_agricola_app(t, pdfs):
    op = re.search(r"tu transacci.n:\s*\*?(.+?)\*?\s*\.?\s*\n", t + "\n")
    when = re.search(r"Fecha(?:/| y )hora: \*?(\d{1,2}/\d{2}/\d{4}) (\d{1,2}:\d{1,2}:\d{1,2})", t)
    if when and not op and NON_MONEY.search(t):
        return {"no_dinero": True}
    if when and not op and re.search(r"has recibido un abono", t):
        return {"no_dinero": True}  # the other bank's receipt of our own Transfer365, already counted
    if not (op and when):
        return None
    if NON_MONEY.search(op[1]):
        return {"no_dinero": True}
    amount = None
    extra = ""
    name = concept = ""
    for p in pdfs:
        flat = re.sub(r"\s+", " ", p)
        a = re.search(r"Monto total debitado \$?\s*([\d,]+\.\d{2})", flat) or re.search(
            r"(?:Monto|MONTO|Valor|VALOR|Total|TOTAL)[^\d$]*\$?\s*([\d,]+\.\d{2})", flat)
        if a:
            amount = money(a[1])
            extra = flat[:600]
            n = re.search(r"Nombre del destinatario (.+?) (?:Celular|Cuenta|Monto)", flat)
            c = re.search(r"Concepto (.+?) (?:Cuenta d.bito|Impuesto|Estado)", flat)
            name = n[1].title() if n else ""
            concept = c[1] if c else ""
            break
    body_amt = re.search(r"\nMonto: \$?\s*([\d,]+(?:\.\d+)?)", t)
    if amount is None and body_amt:  # older emails put the amount in the body, no PDF
        amount = money(body_amt[1])
        b = re.search(r"Nombre del beneficiario: (.+)", t)
        c = re.search(r"Concepto: (.+)", t)
        dest = re.search(r"Instituci.n destino: (.+)", t)
        name = b[1].strip() if b else ""
        concept = c[1].strip() if c else ""
        if re.search(r"Transfer365", op[1]):
            return {"cuenta": "Agricola cuenta", "comercio": f"Transfer365 a {name or '?'} ({dest[1].strip() if dest else '?'})"
                    + (f" [{concept}]" if concept else ""), "beneficiario": name, "concepto": concept,
                    "banco_destino": dest[1].strip() if dest else "", "monto": amount, "moneda": "USD",
                    "fecha": dmy(when[1], when[2]), "estado": "Aprobada", "detalle": "transferencia",
                    "t365": True}
    label = op[1].strip().rstrip(".")
    if name:
        label = f"{label}: {name}" + (f" ({concept})" if concept else "")
    return {
        "cuenta": "Agricola cuenta",
        "comercio": label,
        "beneficiario": name,
        "concepto": concept,
        "monto": amount,
        "moneda": "USD",
        "fecha": dmy(when[1], when[2]),
        "estado": "Aprobada",
        "detalle": "app",
        "comprobante": extra,
    }


def parse_rechazo(t):
    when = re.search(r"Fecha y hora: (\d{2}/\d{2}/\d{4}) (\d{2}:\d{2}:\d{2})", t)
    tipo = re.search(r"Tipo de transacci.n: (.+)", t)
    dest = re.search(r"Instituci.n destino: (.+)", t)
    if not when:
        return None
    return {
        "cuenta": "Agricola cuenta",
        "comercio": f"Rechazada: {tipo[1] if tipo else '?'} ({dest[1] if dest else ''})",
        "monto": None,
        "moneda": "USD",
        "fecha": dmy(when[1], when[2]),
        "estado": "Rechazada",
        "detalle": "rechazo",
    }


def parse_bac_retiro(t):
    monto = re.search(r"Monto: ([\d,]+\.\d{2})", t)
    when = re.search(r"retir. el dinero: (\d{1,2}/\d{2}/\d{4}) (\d{1,2}:\d{1,2}:\d{1,2})", t)
    lugar = re.search(r"Lugar donde se retir. el dinero: (.+)", t)
    if not (monto and when):
        return None
    return {
        "cuenta": BAC_CUENTA,
        "comercio": f"Retiro sin tarjeta {lugar[1].strip() if lugar else ''}".strip(),
        "monto": money(monto[1]),
        "moneda": "USD",
        "fecha": dmy(when[1], when[2]),
        "estado": "Aprobada",
        "detalle": "retiro",
    }


def parse_bac_transfer(t):
    monto = re.search(r"monto de ([\d,]+(?:\.\d+)?)", t) or re.search(r"USD ([\d,]+(?:\.\d+)?)", t)
    when = re.search(r"(\d{1,2}/\d{1,2}/\d{4}) a las (\d{1,2}:\d{1,2}:\d{1,2})", t)
    who = re.search(r"Enviada por\n(.+)\n(.+)", t)
    if not (monto and when):
        return None
    return {
        "cuenta": BAC_CUENTA,
        "comercio": f"Transferencia: {who[1].strip()} / {who[2].strip()}" if who else "Transferencia BAC",
        "monto": money(monto[1]),
        "moneda": "USD",
        "fecha": dmy(when[1], when[2]),
        "estado": "Aprobada",
        "detalle": "transferencia_bac",
        "texto": t[:700],
    }


RULES = [
    (r"ABONO A CUENTA", "ignorar", lambda t, p: {"no_dinero": True}),  # money received, not spending
    (r"^Alerta PRF", "bac_compra", lambda t, p: parse_bac_compra(t)),
    (r"compra con TDC", "agricola_compra", lambda t, p: parse_agricola_compra(t)),
    (r"Transfer365", "agricola_t365", lambda t, p: parse_t365(t)),
    (r"Transacci.n Rechazada", "agricola_rechazo", lambda t, p: parse_rechazo(t)),
    (r"Notificaci.n de transacci.n en (Banca M.vil|e-banca)", "agricola_app", lambda t, p: parse_agricola_app(t, p)),
    (r"Retiro sin tarjeta retirado", "bac_retiro", lambda t, p: parse_bac_retiro(t)),
    (r"Movimiento Monetario|Notificaci.n de Transferencia", "bac_transfer", lambda t, p: parse_bac_transfer(t)),
]


def main():
    movs, failed, ignored = [], [], 0
    for path in sorted(RAW.glob("*.eml")):
        m = email.message_from_bytes(path.read_bytes())
        s = subject(m)
        rule = next((r for r in RULES if re.search(r[0], s)), None)
        if not rule:
            ignored += 1
            continue
        t = text_of(m)
        pdfs = pdf_texts(m) if rule[1] == "agricola_app" else []
        row = rule[2](t, pdfs)
        sent = email.utils.parsedate_to_datetime(m["Date"]).isoformat()
        if not row:
            failed.append({"gmail_id": path.stem, "asunto": s, "enviado": sent, "texto": t[:500]})
            continue
        if row.get("no_dinero"):
            ignored += 1
            continue
        if row.pop("t365", False):
            rule = (rule[0], "agricola_t365", rule[2])
        row.update({"tipo_fuente": rule[1], "gmail_id": path.stem, "enviado": sent})
        row["clave"] = key(row["tipo_fuente"], row["cuenta"], row["monto"], row["comercio"], row["fecha"])
        movs.append(row)
    movs.sort(key=lambda r: r["fecha"])
    OUT.write_text(json.dumps({"movimientos": movs, "sin_leer": failed}, ensure_ascii=False, indent=1))
    from collections import Counter
    print("parsed:", dict(Counter(r["tipo_fuente"] for r in movs)))
    print("no amount:", dict(Counter(r["tipo_fuente"] for r in movs if r["monto"] is None)))
    print("estado:", dict(Counter(r["estado"] for r in movs)))
    print("could not parse:", len(failed), "| not transactions:", ignored)
    for f in failed[:8]:
        print("  FAIL", f["asunto"], f["enviado"], f["texto"][:200].replace("\n", " / "))


if __name__ == "__main__":
    main()
