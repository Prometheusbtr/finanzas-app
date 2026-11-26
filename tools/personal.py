"""Load the owner's personal rules from data/personal_rules.json.

People's names, payment handles and real account labels live there, outside git
(data/ is ignored), so the code holds no private data. Without the file every tool
still runs; the personal rules are just empty.
"""
import json
import sys
from pathlib import Path

FILE = Path.home() / "finanzas" / "data" / "personal_rules.json"


def load():
    try:
        return json.loads(FILE.read_text(encoding="utf-8"))
    except FileNotFoundError:
        print(f"note: {FILE} not found, running without personal rules", file=sys.stderr)
        return {}


PERSONAL = load()
