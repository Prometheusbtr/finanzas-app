"""Read-only copy of bank emails from Gmail into ~/finanzas/data/raw/gmail/.

Melvin approved (Nov 25 2026) reusing the Gmail app password stored in
~/.config/finanzas/gmail.env. It is read at run time, never copied or printed.
The mailbox is opened read-only, so nothing is marked read, moved or deleted.
One-time codes and password emails are skipped and never saved.

Usage: python tools/fetch_gmail.py [since YYYY/MM/DD]
"""
import email.header
import imaplib
import socket
import ssl
import sys
from pathlib import Path

ENV = Path.home() / ".config" / "finanzas" / "gmail.env"
OUT = Path.home() / "finanzas" / "data" / "raw" / "gmail"

SENDERS = [
    "info@baccredomatic.com",
    "alerta@baccredomatic.com",
    "notificaciones@baccredomatic.com",
    "notificacionesbancoagricola.com",
    "bancoagricolasv.com",
    "ebancapersonas@bancoagricola.com",
    "bancamovilba.com",
]
SKIP_WORDS = ["otp", "contraseña", "contrasena", "clave", "código", "codigo", "token"]


def env_value(key):
    for line in ENV.read_text().splitlines():
        if line.startswith(key + "="):
            return line.split("=", 1)[1].strip().strip("\"'")
    raise SystemExit(f"{key} not found in {ENV}")


class IMAP4v4(imaplib.IMAP4_SSL):
    """IMAP over IPv4 only (home wifi IPv6 is broken)."""

    def _create_socket(self, timeout):
        addr = socket.getaddrinfo(self.host, self.port, socket.AF_INET, socket.SOCK_STREAM)[0][4][0]
        sock = socket.create_connection((addr, self.port), timeout)
        return ssl.create_default_context().wrap_socket(sock, server_hostname=self.host)


def subject_of(raw):
    msg = email.message_from_bytes(raw[:20000])
    try:
        return str(email.header.make_header(email.header.decode_header(msg.get("Subject", "")))).lower()
    except Exception:
        return (msg.get("Subject") or "").lower()


def main():
    since = sys.argv[1] if len(sys.argv) > 1 else "2026/08/01"
    OUT.mkdir(parents=True, exist_ok=True)
    imap = IMAP4v4("imap.gmail.com", 993, timeout=60)
    imap.login(env_value("SMTP_USER"), env_value("SMTP_PASSWORD"))
    imap.select('"[Gmail]/All Mail"', readonly=True)

    query = "(" + " OR ".join(f"from:{s}" for s in SENDERS) + f") after:{since}"
    _, data = imap.uid("SEARCH", "X-GM-RAW", f'"{query}"')
    uids = data[0].split()
    saved = skipped = 0
    for uid in uids:
        _, msg = imap.uid("FETCH", uid, "(X-GM-MSGID BODY.PEEK[])")
        header, raw = msg[0]
        gmid = header.decode().split("X-GM-MSGID ")[1].split()[0].rstrip(")")
        if any(w in subject_of(raw) for w in SKIP_WORDS):
            skipped += 1
            continue
        path = OUT / f"{gmid}.eml"
        if not path.exists():
            path.write_bytes(raw)
        saved += 1
    imap.logout()
    print(f"found {len(uids)}, saved {saved}, skipped (codes/passwords) {skipped} -> {OUT}")


if __name__ == "__main__":
    main()
