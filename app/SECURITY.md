# Finanzas security notes

Owner: Seguridad (security agent). Last update: Nov 25 2026, Wave 2 import review, branch `seguridad-review-w2`.
Changes to login, `public/_headers`, `wrangler.jsonc`, `public/sw.js`, migrations, `src/lib/security.ts`
and `test/security.test.ts` need Seguridad's OK.

## How to check

    cd app && nvm use
    npm run typecheck && npm test && npm audit --omit=dev --audit-level=high
    scripts/git-privacy-check.sh       # nothing private is tracked or would be added
    scripts/vendor-pdfjs.sh --check    # public/vendor/pdfjs-6.5.438 is the vetted build (deploy.sh runs it too)
    scripts/attack.sh                  # throwaway server on 8791, then headless Chrome (FZ_ATTACK_PORT=8792 if 8791 is busy)

`attack.sh` makes its own database in `.wrangler/attack-state` and deletes it after. It refuses ports 8788 and 8790.
It needs the Playwright venv at `~/.venvs/finanzas-tests` and Google Chrome.

## Findings (audit of Nov 25 2026)

| ID | Finding | Status | Fix | Test |
|----|---------|--------|-----|------|
| H1 | Private data (family names, a payment handle, the real card ending) would go into git | Fixed (commit dc0590b) | Personal rules in `data/` (ignored), neutral test data, `.gitignore`, `scripts/git-privacy-check.sh` | privacy check |
| H2 | `add-user.ts` printed the live passphrase, so it could land in an AI session log | Fixed | Passphrase goes only to `/dev/tty`; refuses without a terminal; `--local-login` file only for SQL files named "local" | manual run below |
| H2 | `wrangler login` gives full account access | Fixed (docs) | README: Melvin makes a Cloudflare API token with Workers Scripts Edit and D1 Edit only, typed with `read -s` | n/a |
| M1 | Anyone could keep a user locked out; 100 tries at once all got through before the counter moved | Fixed | Lock per username plus IP (IPv6 by /64), each try counted in one atomic statement before the check, 10 tries a minute per IP, old rows cleaned on every login, only hashes stored | security.test.ts "M1", attack.sh |
| M2 | Sessions slid forever | Fixed | 180-day hard limit, `POST /api/logout-all`, a trigger ends all sessions when the passphrase changes (any path), owner-only `GET /api/users` and `POST /api/users/:id/logout-all`, `--reset` in add-user | security.test.ts "M2", attack.sh |
| Low | Cookie | Fixed | `__Host-fz_s`, Secure, HttpOnly, SameSite=Strict, Path=/; plain `fz_s` (not Secure) only on http://127.0.0.1 and http://localhost | "session cookie" |
| Low | Cross-site requests | Fixed | Writes need JSON, a matching Origin and Sec-Fetch-Site same-origin when sent; reads refuse cross-site and same-site | "requests from other sites" |
| Low | Headers missing on API errors; no HSTS or isolation headers | Fixed | `src/lib/security.ts` headers on every API response (200 to 500); `_headers` adds HSTS, COOP, COEP, CORP | "security headers", attack.sh |
| Low | Cloudflare request logs keep search words; preview URLs | Fixed | `wrangler.jsonc`: observability, logs, traces and logpush off; `preview_urls` false; `send_metrics` false | dry-run build |
| Low | Service worker cached any same-site file | Fixed | Caches only the SHELL list, keyed by path, cache v3 | attack.sh (cache holds only the shell) |
| Low | Logout left page data in memory | Fixed | Logout reloads the page | attack.sh |
| Low | No limits on offset, dates, body size | Fixed | offset 0 to 100,000, limit whole numbers, dates 2000-01-01 to tomorrow, body 64 KB with or without a length header | "size and range limits" |
| Low | Invisible direction characters | Fixed | Removed from every JSON string the browser sends and from bank shop names | "invisible direction characters" |
| Low | Database allowed links across users | Fixed | Migration 0002: triggers refuse cross-user links and any change of `user_id` | "the database refuses links" |
| Low | `review.ts` subqueries without `user_id` | Fixed | `user_id` added to all four | "review.ts only looks at" |
| Low | `$&` bug in `t()` | Fixed | split/join in `public/js/i18n.js` | "t() puts values in exactly", attack.sh |
| Low | `seed.ts` printed ledger rows | Fixed | Prints counts and row numbers only | grep |
| Bug | `seed:sql` pointed at a missing `seed.mjs` | Fixed | `scripts/seed.ts` | rebuilt a throwaway DB |
| New | Named exports in `src/index.ts` stop the Worker from starting (found by attack.sh) | Fixed | Constants moved to `src/lib/security.ts` | "worker entry" |

Open: no Critical, High or Medium.

## Design notes

- Login counters (`login_limits`): `ip:<sha256>` with 10 tries a minute and `name:<sha256 of username + IP>` with 5 tries
  in 15 minutes. Each request first adds 1 in a single `INSERT ... ON CONFLICT DO UPDATE ... RETURNING`, then decides.
  A burst of 40 at once from one IP: 10 reach the username counter, 4 get "wrong", 36 get 429.
  The IP comes from `CF-Connecting-IP`, which Cloudflare sets and overwrites. Local dev passes it through, which is fine.
- Rate limit binding: not used. Cloudflare's docs do not say the free plan has it, and it counts per location and
  only roughly. The database counter is exact and costs at most 2 writes per login try.
- Cross-user keys: real composite foreign keys need the tables rebuilt. In D1 dropping the old table runs its
  ON DELETE CASCADE rules and deletes rows, so triggers do the same refusal and every row stays as it is.
  Checked on a copy of the local database: every row of all 8 tables the same before and after (row fingerprints), 0 cross-user links.
- Owner: `users.is_owner`. Migration 0002 makes the first user the owner; on a new database the first
  `add-user.ts` run sets it.
- Sessions: 90 days, renewed while used, never past 180 days from sign-in. Any change to `pass_salt` or `pass_hash`
  deletes all of that user's sessions in the database itself (trigger `users_login_changed`).
  A future login method (passkeys) needs the same trigger on its table.
- Template SQL that the greps find is safe: `owned.ts` table name is a fixed union, `review.ts` builds only `?`
  placeholders, `merge.ts` picks one of two fixed strings, `movements.ts` joins fixed fragments with `?`.
  `add-user.ts` and `seed.ts` write SQL files with quoted values from trusted local input.
- The only runtime log line is `server error: <message>` in `onError`, and Cloudflare logs are off.

## Review of commit 074139d (app.js split, sw.js v2)

The split keeps the code the same: the set of code lines matches the old `app.js` except one indirection
(`hooks.authLost`, so `api.js` does not import the login screen). Same 13 `innerHTML` uses, all through `esc()`.
Same `data-act` and view names. `sw.js` v2: OK, with the Wave 1 change that it now caches only the shell list (v3).

## Review of Diseño's style B (commit 6f4f958, Análisis and Más)

Result: OK to merge, with one fix.

What was checked:
- Every `innerHTML` with data goes through `esc()`. Numbers go through `money()`, and ids come from the server.
- `charts.js` uses no `innerHTML`. Every label, tooltip and table cell is set with `textContent` or `setAttribute`, and
  positions are set through `element.style`. That is allowed under our CSP.
- No inline styles, no inline handlers, no `javascript:` links and no eval. `app.css` loads nothing from outside.
- `sw.js` adds the new modules and `/icons.svg` to the shell. The cache still holds only the shell, and nothing from
  `/api` (the attack script checks this).
- `icons.svg` has 34 symbols. All of them are inert, match Tabler 3.51.0 exactly and have no duplicate ids. Every icon
  the code uses exists.
- No secrets and no real amounts in any file. The privacy check, typecheck, 52 tests and npm audit are all clean.

Address-bar values:
- `day=` is checked against a date pattern before it is used in a selector, and `estado` and `p` are allowlists.
- Fixed: Análisis took `at=2026-00-00` or `at=0001` as a date, which threw an error or asked the server for 12 empty
  months. It now accepts only real dates from 2000 on and otherwise shows the current period.

The attack script now also covers:
- Análisis (month, week and year) and Más.
- Movimientos opened at a day.
- Every chart tooltip.
- 8 hostile address-bar values.

Mutation checks confirmed the script catches each of these: shop names not escaped, tooltips built with `innerHTML`,
and the date fix undone.

Rule: `tHtml()` escapes the sentence but not its values. Every value passed to it must already be escaped (`esc()`)
or come from `money()`.

## Results, Nov 25 2026

- Tests: 52 pass (25 before, 27 new in `test/security.test.ts`). Type check clean.
- `npm audit --omit=dev --audit-level=high`: 0 vulnerabilities (full audit also 0).
- Privacy check: OK, 75 files and 3 commits, nothing private.
- Greps: no eval, `new Function`, `document.write`, string timers or `insertAdjacentHTML`; logging as above.
- `attack.sh`: 51 of 51 checks pass.
  Payloads used as shop, note, tag, group, category, account and display names: `<img onerror>`, `<script>`,
  `<svg onload>`, attribute breakout, `javascript:` and `$&`, plus 6 spreadsheet formulas.
  Bob was refused on all 17 cross-user tries and saw none of alice's data. Cross-site and wrong-type writes
  refused and nothing saved. 70 KB body refused. Every screen and sheet opened in headless Chrome for both users:
  no payload became HTML, no script ran, no CSP report, no page errors, page cross-origin isolated,
  service worker cache only the shell, logout reloads and drops the cookie.
  Control run: with `esc()` broken on purpose the same run fails 3 checks (and the CSP still blocks execution).
- `add-user.ts`: without a terminal it refuses and writes nothing. In a terminal the passphrase appears on the
  screen once and in none of stdout, stderr or the SQL file. `--local-login` refuses SQL files without "local".
- Migration 0002 applied to a copy of the local database: data identical, owner set, 16 triggers.
  A throwaway database rebuilt from the ledger with both migrations gives the same counts as today.

## Design round 3 review (Nov 25 2026)

Scope: Diseño's commits 5deaaa1 to d958c67 (calmer Home, glass tab bar and sheets, `js/motion.js`, chart
animation, black and white icon, sw.js v4) and master's 480e068 (`scripts/deploy.sh`). Result: OK to merge with the
fixes below. No Critical, High or Medium.

What was checked:
- `_headers` is byte-identical to 480e068. `src/`, `migrations/`, `wrangler*.jsonc`, `package.json` and the lock are
  untouched. No new packages and no outside URLs; `app.css` loads nothing.
- No inline scripts or styles, no `style=` anywhere (HTML, JS strings, SVG), no eval, `new Function`,
  `document.write`, string timers or `insertAdjacentHTML`. The 19 `innerHTML` uses are the same ones as before.
  Motion goes through `element.animate()`, classes and the CSSOM (`el.style.transform` for the sheet drag, the tab
  pill's width and position), which `style-src 'self'` allows.
- Home: every group, category and label goes through `esc()` (it escapes `& < > " '`, so quoted attributes are
  safe too). Amounts go through `money()` or the new `moneyWhole()`, both safe for any input (worst case "$NaN").
  `month` in the new hrefs is now escaped as well, and it only ever comes from `shiftMonth()` or the server's date.
  The fold row, the Revisar row (server count), `data-w`/`data-x` (numbers) and aria-labels are fine.
  `tHtml()` only gets `money()`/`moneyWhole()` values.
- `charts.js` still builds every label, tooltip row and table cell with `textContent`; the new reveal layer has no
  data in it. `countUp()` writes with `textContent`.
- Navigation: no `location` or `window.open` from data. All links are fixed `#/...` paths. `data-nav` only picks an
  animation, and `history.state.fz` is only read as a number. No open redirect.
- `sw.js`: MODULES lists all 18 files under `public/js`, nothing else. CACHE is `fz-shell-v4`, old caches are still
  deleted on activate, `/api/` is never cached.
- Icons: the four PNGs hold only IHDR, IDAT and IEND; `icon.svg` is four shapes.

Findings and fixes:
- Low, fixed (f606471): when a session ended while the app was open (it ran out, "sign out everywhere", the owner's
  tool, a new passphrase), the login form showed but the page kept its memory. Home's new count-up starts from the
  last number it showed, so whoever signed in next on that page saw the previous user's "what's left" in the first
  frames. Now the form shows and the page reloads, as Sign out does. A page that never had a session does not
  reload, so there is no loop. This also ends an older race where a slow screen could paint over the login form.
  attack.py ends alice's session from outside the page, signs bob in on the same page and records every frame of the
  big number: it fails without the fix and passes with it.
- Low, fixed (baf32dd), `deploy.sh`:
  - Enter with no token fell back to wrangler's browser login, which has full account access and is kept on disk.
    It now refuses.
  - A Global API Key in the window wins over the token in wrangler, so those variables are unset.
  - The account id is fixed (not taken from the window).
  - The config must hold a real database id: wrangler 4 provisions a new empty database for a binding without one
    (on by default) and would point the live app at it.
  - `WRANGLER_NO_SKILLS_UPDATE_PROMPTS=true`, so wrangler never offers to write skills into AI tool settings.
  - Checked as well: the token is never echoed, logged, written or put on a command line, a pipe is refused, and
    `wrangler deploy` applies no migrations. The temporary-account path needs `--temporary`, which the script never
    passes.
  - Tested on a copy with a stub in place of wrangler, in a pseudo-terminal (`script`): no terminal, an empty token,
    a stray key and account id, and a missing or placeholder database id. The token never shows when it is typed
    after the prompt.
- Test gap, fixed (630a1ca): attack.py's shell list was a hard-coded copy, so it failed on `js/motion.js`. It now
  takes the modules from `public/js` on disk, and a new check fails when sw.js leaves one out. It also adds a payload
  group with a limit and no spending (the "N grupos sin gasto" row) and a category limit (an over-limit row with a
  bar), then opens the fold and every group panel on Home. Control run: dropping "motion" from sw.js or `esc()` from
  the group name fails 4 checks, and the CSP still blocks the script.

Results:
- Type check clean. 52 tests pass. `npm audit` finds 0 vulnerabilities (both the `--omit=dev` run and the full one).
  Privacy check OK.
- `attack.sh` (run with `FZ_ATTACK_PORT=8792`): 59 of 59 pass. That is the 55 from before plus the no-spending
  payload group saved, all modules cached, Home's open panels showing names as plain text, and the session switch.
  On the new Home, in headless Chrome for both users, no payload became HTML, no script ran, there was no CSP report
  and there were no page errors.

## Speed round review (Nov 25 2026)

Scope: 10730ef (screens shown at once from memory, the S.nav counter, the touch prefetch, the Movimientos page
guard, the index.html skeleton, shorter motion, sw.js v5), with a quicker look at 84053ca, 9e7796d and bf401b9.
Branch `seguridad-review-speed`. Result: OK to merge with the fixes below. No Critical, High or Medium.

What was checked:
- `_headers`, `src/`, `migrations/`, `wrangler*.jsonc`, `package.json`, the lock and `test/` are untouched from
  73c22ef to 10730ef, and on this branch. No new packages and no outside URLs.
- The memory (`js/data.js` `cached`): in the page only, never in `localStorage` or the service worker cache (sw.js
  still skips `/api/`). At most 60 keys, oldest dropped first. A load already running is shared, a value under 5 s
  old is not loaded again, and a load that ran across a change (`memo.gen`) keeps nothing.
- `api.js` empties the memory before and after every non-GET call, also on an error or offline, so no screen
  is drawn from memory with numbers from before a save, edit, delete, categorize or merge.
- Quiet redraws only run while their screen change is the newest one (`S.nav`) and nothing was saved meanwhile
  (`memo.gen`). A stale render paints no error and does not touch the scroll or the motion kind.
- Prefetch: only on a touch on the tab bar or on links marked `data-pre`, never while scrolling rows. The href goes
  through `parseHash` and the screen's own PARTS, so the only possible keys are fixed names plus values that
  `URLSearchParams` puts in the query string. Keys are Map keys only: they never reach HTML or a URL path.
- Movimientos drops a page that comes back for an older list (a filter changed meanwhile).
- Same 18 `innerHTML` uses as before, all through `esc()`. No `style=`, eval, `new Function`, `document.write`, string
  timers or `insertAdjacentHTML`. The skeleton in index.html has no data. `data-i18n-label` is set with
  `setAttribute("aria-label", t(...))`. `localStorage` holds only the theme choice.
- Motion: `--dur-*` and `DUR` match (150, 220, 340 ms). Taps stay blocked during the 340 ms push and pop slides
  (73c22ef closed the round 3 open item). sw.js v5: MODULES lists all 18 files under `public/js`.
- Cost: a tap or touch costs the same reads as before at most; repeat taps within 5 s and parallel touches share
  one load, and Home warms only Movimientos and Análisis when memory has nothing for them. No new routes.

Findings and fixes (all Low):
- Fixed (6ca6c12): a 401 did not empty the memory or end the loads on their way. An answer for the old user that
  arrived after their session ended still ran its draw; with `S.boot` gone it failed and painted "Algo falló" over
  the login form, and the memory kept the old user's screens until the reload. Now a 401 empties the memory and
  bumps `S.nav`, so a late answer draws nothing.
- Fixed (bebf491): when someone signed in before the reload after a session end had come (slow network), the app
  drew their screens on the old page. The page keeps more than the memory (the Movimientos list, filters, Home's
  last number for the count-up): with the reloads switched off, bob's frames showed alice's rows 57 times. Now a
  sign-in on a page that had a session reloads it at `#/`. One person's session per page.
- Fixed (434f3d4): another tab of the app kept the old user's screens and memory after a sign out and a new sign in
  in this tab, and drew them again from memory. A successful sign in or sign out now tells the other tabs through
  a `BroadcastChannel` ("fz-session") and they reload. Older in part (the screen on show stayed before too), but the
  memory made it wider. Not an issue in the iPhone Home Screen app, which has one window.
- Fixed (f2db269), older than this round: tapping Home while a purchase was still saving left Home with the numbers
  from before the save (the hash was "#/" already, so setting it did nothing). The save, and the duplicate question
  after it, now render Home again in that case.
- Fixed (706bfd5): `#constructor`, `#__proto__` or `#toString` found Object's own members in VIEWS (and the same in
  ACT and PARTS) instead of falling back to Home. Harmless; the registries are now `Object.create(null)`.
- Tests (0c704d3): attack.py now holds the session switch with the memory warm (Home, Movimientos and Análisis
  seen; alice's session ended from outside; bob signs in on the same page; every frame of the big numbers and every
  DOM change checked for alice's mark), a late answer after a session end with the reload held off, a sign-in on
  that page before its reload, a save racing a Home load both ways round, two tabs, and three object-name hashes.
  The held reload uses a `beforeunload` prompt that the test dismisses, because Playwright waits on a held
  document request. Control runs, one fix taken out at a time, each fail the check that guards it: no authLost
  reload and no sign-in reload (session switch: alice's Home and Análisis numbers and 57 frames with her rows), no
  401 fix (late answer), no sign-in reload (sign-in before the reload: bob drawn on alice's page from her number),
  no save fix (both save races), no channel (two tabs), old registries (hostile hashes).

Results:
- Type check clean. 52 tests pass. `npm audit` finds 0 vulnerabilities (both the `--omit=dev` run and the full one).
  Privacy check OK before every commit.
- `attack.sh` (run with `FZ_ATTACK_PORT=8792`): 68 of 68 pass (59 before, 9 new: memory warm before the session
  ends, 3 late answer, 3 save race, 2 two tabs). The session switch now runs with the memory warm, and the hostile
  hashes include the three object names. On master (10730ef) these fail: the late answer, both save races, two tabs
  and the object-name hashes. In every run, for both users, no payload became HTML, no script ran, there was no CSP
  report and there were no page errors.

## Importar review (Nov 25 2026)

Scope: Importar's branch `worktree-agent-a8101e53ef356d012` (e7da256, e021a7c, 382cf6c, 4ec7174 on master 591b323):
statements read on the phone (pdf.js and a CSV worker), `/api/imports*`, Pagos fijos, Primeros pasos 4 to 6
(`#/pasos/ahorro`, `#/pasos/limites`) and migration 0004. Branch `seguridad-review-importar`. Result: OK to merge
with the fixes below. No Critical or High. The Mediums are fixed.

What was checked:
- `_headers` and the CSP are unchanged. The `.mjs` files are served as `text/javascript` under nosniff, and both
  workers carry COEP and CORP (attack.sh checks the headers and the sha256 of what is served).
- pdf.js is called with the vetted options (`data` only, `useWasm: false`, `enableXfa: false`, `disableFontFace`,
  no system fonts, no `rendererSrc`, same-origin worker). No font, CMap, ICC or WASM URL, so it fetches nothing.
- Limits on the phone: CSV 5 MB and 2,000 rows, PDF 10 MB and 50 pages, 30 s, 6 files. On the server: 500 rows per
  request, 2,000 per import, 5,000 per day, 50 imports per day, a period of at most 400 days, every row inside it.
- The PDF password lives only inside one `readPdf` call. The form is reset, and attack.sh finds it in no request,
  storage, cache or page. Only rows leave the phone: an unmapped CSV column and the file bytes never do.
- The server checks every row again (zod, period, cents) and builds the dedupe keys itself. Undo works, and a
  second import of the same statement adds nothing.
- Starter rules (`src/lib/rules.ts`): compared with `personal_rules.json` and `privacy_terms.txt`. Only generic
  category words overlap; no private term. One brand name in them is already in master's `tools/categorias.py`.
- Every new id route returns 404 to another user (`imports/:id/rows|finish|undo|review`). The column map answer
  for a map that is not yours is the same as for no map (`{account_id: null, map: null}`), scoped by `user_id`, so
  it tells nothing. The 0004 triggers exist for every link. `recurring_choices` and `savings_plan` have only the
  "user_id fixed" trigger because they hold no links. Deleting a user removes all their 0004 rows (test).
- No `style=`, inline script or handler. Every text from a file goes through `esc(mask())`. `sw.js` v6 lists all 19
  modules, and `/import/` and `/vendor/` stay out of the cache (attack.sh).
- Migration 0004 on a copy of the main local database (at 0002): the 9 existing tables have the same row
  fingerprints (count and sha256 over every row), 5 new empty tables, 16 to 27 triggers, no foreign key problem.
- "After an undo, the merge memory stays": the shop to category rules learned when a typed row merged into an
  imported one, and the categories picked in Revisar, stay after undo. They are the user's own choices, in their
  own `merchant_rules`, and only sort their future rows. Kept on purpose.

Findings and fixes:
- Medium, fixed (949bc71): money in from a general CSV (a bank account, no type column) was saved as abono, which
  subtracts from spending: a pay of $1,500 took $1,500 off the month's spending. It is now ingreso, waiting in
  Revisar. Only the user makes it a refund. Preview takes the source too, so its counts follow the same rule.
- Medium, fixed (949bc71): a typed row merged into an imported row later (Revisar's "es la misma compra", or the add
  screen) was deleted by the merge, and undoing the import deleted the bank row: the typed row, with its category,
  note and tags, was gone. `mergeManualIntoBank` now keeps a copy on the import's row in the same write (`prev`
  is a list), and undo brings it back.
- Medium, fixed (949bc71): a second import whose key matched a row the user had moved (another account or date, or
  marked rechazado) recorded that row as its own "added", so undoing the second import deleted the user's row. An
  import now records "added" only when the row's `raw` is the one it wrote; otherwise "already".
- Low, fixed (949bc71): undo put typed rows back with a fixed column list, so a column added to `movements` later
  would have come back empty without a word. It now reads the columns from the schema (`PRAGMA table_info`).
- Low, fixed (e8d77e8): a typed row freed the highest id when it merged, the next row took that id, and undo
  skipped the typed row (restored 0). It now comes back under a new id when its old one is taken.
- Low, fixed (6b6a0ac): the pdf.js builds were not committed, so a fresh clone deployed an import screen that
  could not read PDFs. They are committed now. The privacy check skips their text only at those two paths and only
  while the bytes match the pinned sha256 (working copy, staged copy and every committed version).
  `vendor-pdfjs.sh --check` checks the three files, and `deploy.sh` refuses to publish without them.
- Low, fixed (9651401): the `.d.ts` type files for the tests were served from `/import/`. `public/.assetsignore`
  leaves them out.
- Low, fixed (949bc71): digit masking ran only on the phone. The server now masks the shop name and `raw` with the
  same rules, plus runs of 12 or more digits with spaces (an Amex number written 4-6-5 got through both before).
  A test keeps the two the same.
- Info (9651401): pdf.js `verbosity` is now ERRORS. The standard-font warnings for statements that do not embed
  their fonts change nothing for text.

Results:
- Type check clean. 96 tests pass (88 before, 8 new). `npm audit --omit=dev` finds 0 vulnerabilities. Privacy
  check OK before every commit. Control runs, one fix taken out at a time, each fail the test that guards it.
- `attack.sh` (run with `FZ_ATTACK_PORT=8792`): 93 of 93 pass (68 before, 25 new). alice imports, through the import
  screen, a made-up bank CSV and a made-up PDF with payloads in the file names, CSV headers and rows, a PDF script
  open action and a `javascript:` link, then the same PDF locked with RC4 (a wrong password, then the right one),
  plus files over both size limits. bob is refused on 20 tries at her imports, undo, rows, column map, account
  and fixed payments. Importar, ahorro and límites are in both users' screen walks. With the file name's `esc()`
  taken out, 4 checks fail and the CSP blocks the handlers.

## Cuentas review (Nov 25 2026)

Scope: the Cuentas branch, 6 commits on master 591b323 (ecec2ed to b0b3f4e, 61 files): migration 0003 (invites,
passkeys, sessions list, own password, the Face ID lock), `src/routes/{auth,invites,account}.ts`, `src/lib/passkeys.ts`,
the sign-up, login, lock and Mi cuenta screens, `api.js` and the vendored SimpleWebAuthn browser library.
Branch `seguridad-review-cuentas`. Result: OK to merge with the fixes below. No Critical or High open.

What was checked:
- SimpleWebAuthn: rpID and origin come from config only. Both checks pass `requireUserVerification`. Registration
  asks for a platform, resident key; attestation other than `none` (or `packed` without x5c) is refused before
  verifying. Challenges live 5 minutes, are deleted by the same statement that reads them, and are bound to
  their purpose, user, session and invite. The counter is stored; `cred_id` is unique.
- Vendored `@simplewebauthn/browser` 14.0.0 matches the npm tarball byte for byte; the server package's integrity
  matches the registry. Loaded by `import()` only, not in sw.js.
- Invites: token hashed, 7 days (reset links 3), one use (trigger), at most 2 open (checked inside the INSERT), expiry fixed by
  trigger, link built from APP_ORIGIN with the token after `#`. The sign-up batch uses the invite first, so a
  second sign-up rolls back. The page takes the token out of the address bar with `replaceState`.
- The lock: `requireUnlocked` is default deny; only sign out, sign out everywhere and the Face ID check pass a
  locked session. The proof is per session (hash stored), at most 12 hours, kept in page memory only, dropped after
  5 minutes hidden. CSV export goes through fetch with the proof. Removing the last passkey turns the lock off.
- Sessions end through triggers on every login-method change (passkey added, removed or changed, password set,
  backup code used or renewed), also for writes straight to the database. The 180-day limit holds in
  `requireUser`. A backup-code sign-in ends all her sessions, turns the lock off and sends her to Face ID again.
- Own password: PBKDF2-SHA256 600k on the phone; the server stores a salted SHA-256 of the result and compares in
  constant time. Same rate limits as the backup code (shared per-name counter).
- Delete my account removes her rows from every table (the test lists the tables from the database).
  Owner routes refuse others and carry no money. Cross-user: every id route answers 404 for another person's id.
- Front end: all new HTML through `esc()`; no inline code; `localStorage` holds the theme only; the memory keeps
  no secret. Melvin's login is unchanged (passphrase, no Face ID needed) and his card setup is hidden.
- Migration 0003 on a copy of the main local database: every existing row identical (row fingerprints before and
  after), the new triggers present. That copy already had 0004 applied, so 0003 ran after 0004: fine.

Findings and fixes:
- Medium, fixed (06ac20e): the passkey, invite, sign-up and reset routes had their own per-IP counter of 20 a
  minute, on top of login's 10, so mixing routes gave 30 tries a minute. They now count on login's counter
  (10 a minute per IP); anything that checks a secret keeps the per-username lock as well.
- Medium, fixed in part (cd013a3, 123aee7): the owner's Face ID reset link lets whoever holds it add a Face ID to
  her account and sign in as her, and she was never told. That breaks "Melvin cannot see your spending" for anyone
  who has to trust the owner. Now Mi cuenta and the Face ID screen list every reset link made for her (when, used
  when, by whom); nothing in the app can hide it.
- Low, fixed (06ac20e): with the server key missing, the made-up salt was HMAC with an empty key, so anyone could
  tell real names from made-up ones. Now it fails closed (500).
- Low, fixed (06ac20e, cd013a3): the salt for a name changed when she set a password, which told a watcher that a
  password exists. Every password now uses the name's own HMAC salt, so the answer never changes; the server
  refuses any other salt.
- Low, fixed (cd013a3): the devices list showed sessions past the 180-day limit (they no longer work).
- Low, fixed (123aee7): a new backup code or a link stayed in the closed sheet's DOM; sign-up kept the backup code
  in memory. Both are cleared now. The backup-code notice now says the lock was turned off, and to make a new code
  if it was not her.
- Low, fixed (2cec21f): `add-user.ts` allowed 2-character usernames; it now uses the sign-up rule (3 to 32).
  `deploy.sh` refuses to publish unless APP_ORIGIN is https and RP_ID is its host (deploy-first.sh copies the
  local `http://localhost` values into the production file otherwise).
- Tests: `test/security-cuentas.test.ts` (shared counter, fixed salt, fail closed, reset history, 180 days, and a
  423 on every route the app registers, so later routes are covered too). Control runs: with the old 20-a-minute
  counter, the fail-open key, a route added to the lock's open list, or the 180-day filter removed, a test fails.

Results:
- `npm ci`, type check clean, 92 tests pass (85 before, 7 new; one changed from 20 to 10 a minute).
  `npm audit --omit=dev --audit-level=high` and the full audit: 0 vulnerabilities.
- `FZ_ATTACK_PORT=8796 scripts/attack.sh`: 101 of 101 pass (68 before, 33 new in `cuentas_part`). attack.sh now starts
  the server with `APP_ORIGIN=http://localhost:<port>` and `RP_ID=localhost`; Face ID runs on Chrome's virtual
  authenticator (CDP) at that address. New checks: payload and look-alike usernames refused, a taken name refused,
  invite links from APP_ORIGIN, 8 sign-ups raced on one invite (exactly one made), the invite and the reset link
  replayed (refused everywhere), sign-up with Face ID and a payload display name in the browser, the token gone from
  the address bar with its history entry replaced, the backup code gone from the page, the cookie flags, the lock
  (423 on 42 routes with no or a wrong proof, another session's proof refused, CSV with the proof), bob against
  dana's sessions and Face IDs (404 each, nothing changed), only the theme in storage, no API answer in the offline
  cache, Personas for the owner (payload names as text) and for bob (sent back, nobody listed), session labels from
  a payload User-Agent, the reset link used once in a new browser, the old Face ID refused after it, and her reset
  history in Mi cuenta. No payload ran, no dialog, no CSP report.
- Control runs: without the address-bar `replaceState` both token checks fail; with `POST /api/me/backup-code` open
  while locked the lock checks fail (vitest fails too).
- Privacy check: OK for this branch's history (41 commits); see the open item for the copy on this branch.
- `add-user.ts ab` refuses and writes nothing. `deploy.sh` guard: production config passes, the local one is refused.
- Merge notes for the lead: master moved to 95e8c8e (Importar). sw.js is `fz-shell-v6` on both sides: make it v7
  with both module lists. deploy.sh, attack.sh, attack.py (`main()` gets `cuentas_part()` after
  `login_abuse_part()`), i18n.js and SECURITY.md need hand merges. Run the tests after the merge: the delete-my-
  account test and the lock's every-route test then also cover 0004's tables and the import routes.

### Rules for Funciones (notifications, Personas, Tarjetas, Recurrentes, currency)

- Every new route goes after `requireUser` and `requireUnlocked` (default deny). A route that must work without a
  session or while locked is added on purpose to the lists in `test/security-cuentas.test.ts`, with a reason.
- Notifications: no amount, shop, note or name in the text or the push payload (lock screens show it). The push
  subscription belongs to one session and is deleted when that session ends (same triggers). Sending is
  per user only, rate limited, and never through a URL from the request.
- Personas: owner screens show names, dates and counts only, never money, movements, categories or totals of
  anyone else. Every owner route uses `ownerOnly`; every id is checked to be a member. No new way to sign in as
  someone else without the history she sees (above).
- Tarjetas: at most the last 4 digits and a name; never the full number, expiry or CVV, not even in a note. Card
  ids checked for ownership (404); `user_id` with the "same user" and "user_id fixed" triggers.
- Recurrentes: a scheduled job has no session, so every statement names `user_id` and the job is idempotent per
  period (a unique key on rule and period). Rules are deleted with the account and never run for a deleted user.
- Currency columns: integer cents plus a currency code from a fixed list (CHECK in SQL); no floats. Never add
  different currencies into one total. CSV export keeps the formula guard on every new column.
- New tables with `user_id`: the triggers above, and the delete-my-account test must still cover them.

## Funciones review (Nov 25 2026)

Branch `seguridad-review-funciones` (= funciones: master 0a5f1b2, merge 48d3860, 5 commits to 15d412a). Verdict:
OK to merge after the commits below; no Critical or High open.

Fixed:
- Medium, fixed (26ca13a): the evening alerts job made about 10 D1 queries per person, one by one, so at about 5
  people it passed the free plan's 50 queries and 50 subrequests per run and stopped half way. Now one read batch
  for everyone, one batch of claims, the sends, one batch after; one VAPID signature per push service
  (`vapidSigner`). Caps per run: 30 people, 3 phones each, 40 sends; whoever is left gets the next evening (claims are
  taken only for what is sent). Test: 20 people with 2 phones each use 4 queries and 40 fetches (under 50 together),
  and a second run sends nothing.
- Low, fixed (6ff2cb9): `/push/test` read the count and then wrote, so taps at the same moment passed the 3 a day.
  The claim is now one `INSERT ... SELECT ... RETURNING` of the first free slot. Test: 6 parallel taps, 3 pass.
- Low, fixed (2c4bce0): Importar's kept answers became Recurrentes with 2 queries each; 25 or more answers passed 50
  queries and `/recurring` failed with 500 every time. Now one SELECT and one batch.
- Low, fixed (ec4f104): undoing an import after a bank row was merged with a typed one deleted the bank row and with
  it the Personas line ("pagó por mí", shares). Undo now moves the line back to the restored typed row first.
- Low, fixed (9f70558): the merge worked out `fx_micros` in floating point; large COP amounts overflowed. Now integer
  math (BigInt), and the rate is dropped (null) outside 1 to 1e14.

Checked, OK:
- `export default Object.assign(app, { scheduled })`: the bundle's only export is `default`, with `fetch` and
  `scheduled` (test). A named export would break the Worker.
- Push: only https on port 443 to Apple, Google, Mozilla and Microsoft push hosts, the address re-checked before each
  send, `redirect: manual`; one subscription per session (ends with it); 404 and 410 delete it. Payloads hold no
  shop, amount or name; `sw.js` opens fixed paths only. VAPID `sub` is the https origin. The private key is a secret
  (never logged; `.dev.vars` is git-ignored and the privacy check now also catches `PRIVATE_KEY=` values);
  `vapid-keys.ts --live` hands it to `wrangler secret put` on stdin. The 409 `taken` (another live session holds that
  phone) tells only that the phone is in use: Info.
- Cron: El Salvador dates, limits once a month, a card once per statement, never for deleted users, each send in
  its own try. "pagó por mí" (no account) is never merged and counts as spending once. "Te quedan" covers the current
  month only; past months never change. A double count needs two rules for one charge or a charge more than 25%
  off: a design point, not security.
- 0005 triggers (same user, user_id fixed), delete-my-account empties every table (test), the every-route 423 test
  covers the new routes. `esc()` on every new text, no inline style or handler, `sw.js` lists every module, CACHE is
  `fz-shell-v9`, only the theme in browser storage. CSV formula guard covers `moneda` and `monto_moneda`. Currency:
  fixed list (CHECK and zod), integer cents up to 1e14. The 3 new icons match Tabler 3.51.0 byte for byte.
- 0005 on a copy of the main local database (at 0004): all 19 existing tables row for row the same, and every month
  summary Dec 2025 to Nov 2026 the same (spending, income, the whole answer). Note: that database got 0004 before 0003.

### Melvin's decisions (Nov 25 2026)

1. The owner's Face ID reset link stays, with a wait. It works only from 24 hours after it is made until its 3 days
   end; before that the page says "todavía no funciona, funcionará desde <fecha>" and nothing changes (the server
   answers 409 `reset_not_yet`, and the `invites_reset_wait` trigger refuses an early use in the database). Making it
   ends nothing; using it ends her sessions. One open link per person (a new one replaces the old). She sees it on
   Home and in Mi cuenta (who, from when) with "Cancelar"; Mi cuenta keeps the history (made, used, cancelled and by
   whom: `invites.cancelled_by` owner, self or replaced, expired). The owner sees "Pendiente, funciona desde ...".
   The welcome screen has the line Melvin wrote ("Si pierdes tu Face ID y tu código de respaldo, ...").
2. A fresh check, under 5 minutes old, before a new backup code, setting or changing a password, adding or removing
   a Face ID, deleting the account and cancelling a reset link, lock on or off, on the server (`requireFresh`: 403
   `{error: "reauth", method}`). The proof is the lock's own (`X-FZ-Unlock`, Face ID through `/unlock`). Without a
   Face ID it is `POST /reauth` with the password (or the passphrase), on the sign-in counters (per IP, and 5 tries
   per name). Signing in with the backup code gives a 5-minute proof (to add a Face ID again); until a new Face ID is
   added the old one no longer counts and the check is the password or that code. Adding a Face ID is in the list
   on purpose: otherwise someone holding an unlocked phone could add their own and pass every later check.
3. Every new string is in tú; the lead moves the rest of the app to tú on master. Tests and attack.py match keys
   and data attributes (`data-reset-wait`, `data-resets`), not Spanish words.

Follow-up (Melvin said yes, Nov 25 2026, after the Wave 2 deploy): the fresh check also guards the owner making a
reset link (`POST /api/members/:id/reset`, after the owner and member checks), removing a person
(`DELETE /api/members/:id`, after the typed-name check, so a typo asks for nothing) and turning the lock off
(`PUT /api/me/lock`; the lock's own proof can be 12 hours old). `api.js` already shows the Face ID or password sheet
on any `{"error":"reauth"}` and sends the request again. Tests: security-decisions.test.ts "Melvin's follow-up" (two:
the check itself, and that a non-owner, a wrong id, the owner himself and a bad body keep their old 403/404/400
without a reauth prompt).

Seguridad review of the follow-up (Nov 25 2026): the order in each route is right and nothing is written before the
check. One screen fix: the check's sheet takes the place of a form shown in a sheet, so closing it put "No se cambió
nada." into a form that was gone (nothing on screen). This hit removing a person, and already, since Wave 2,
deleting your own account and setting a password. `ui.js formError` now shows the message in the form when it is
still there, else as a toast (and closes the check's sheet if it is still up); attack.py checks it on the owner's
screens. Headless at 390 px, light and dark: Restablecer Face ID and Quitar (owner without Face ID) ask for the
passphrase, cancel changes nothing and says so, the right one finishes; a proof aged past 5 minutes asks again;
turning the lock off from Mi cuenta and from Primeros pasos asks for Face ID, cancel keeps it on; no console errors.
Not added, on purpose: `POST /api/users/:id/logout-all` (it only ends sessions, which is the safe direction and the
lost-phone tool; she signs in again). Suggested, not built: `POST /api/invites` (an invite lets a new account in,
like a reset link lets a new Face ID in; rare and owner-only, so the check costs little). Gate after the fix: type
check clean, 175 tests, audit 0, privacy check clean, `FZ_ATTACK_PORT=8792 scripts/attack.sh` 145 of 145.

Results: `npm ci`; type check clean; 173 tests pass (159 on the branch, 7 for the fixes, 7 for the decisions); `npm audit --omit=dev --audit-level=high`: 0;
`scripts/git-privacy-check.sh`: clean; `FZ_ATTACK_PORT=8792 scripts/attack.sh`: 143 of 143 (14 new in `funciones_part`:
payloads in every new field, 17 push addresses refused, bob refused on 20 of alice's ids, every new screen for both
users, the fresh check; the 423 list grew to 69 routes; the Cuentas reset checks follow the 24 hours).

## Rules for other agents

- `src/index.ts` exports only the app. Put shared constants in `src/lib/`.
- Every route that takes an id checks ownership and returns 404; the database triggers are a backstop, not the check.
- Text into HTML only through `esc()`; chart and label text as text, never HTML. No inline scripts or handlers.
- Motion only through `element.animate()`, classes or `el.style.<prop>`; never `style=` in markup or `setAttribute("style")`.
- Module variables may keep one user's numbers only because of one person's session per page: the page reloads at
  Sign out, when a session ends (`hooks.authLost`), at a sign-in on a page that had a session, and in other tabs
  (the "fz-session" channel). Keep those reloads. A 401 also empties the memory and bumps `S.nav`.
- Screen data is kept only through `js/data.js` `cached()` (page memory). Never `localStorage`, `sessionStorage`,
  IndexedDB or the service worker cache; `localStorage` holds the theme choice only.
- Every write goes through `api()` (it empties the memory) and ends with `render()`, a real hash change or a local
  update of the rows on show. Setting the hash the page already has does not render.
- Memory keys and prefetch keys stay Map keys: never put one in HTML or a URL path. Values from the address bar go
  into API URLs only through `URLSearchParams`.
- A new screen adds its loads to PARTS and draws through `showCached`; a redraw that runs later checks `S.nav`.
- A new file under `public/js` goes into `sw.js` MODULES with a CACHE bump; attack.sh fails otherwise.
- New tables with `user_id` get the same "same user" and "user_id fixed" triggers in their migration.
- New migrations: `0002_security.sql` is taken, so the accounts and features migrations move to 0003 and 0004.
- Never print a passphrase, token or ledger row. Never run `add-user.ts` against the live database.
- Outside code only in the versions vetted below, copied into `public/vendor/<name>-<version>/` with its license.
  No CDN, and no `npx` of a version that is not pinned. A minified file that trips the privacy check goes into its
  `VENDORED` list by exact path and sha256, never by folder.
- Import undo puts typed rows back from `import_rows.prev` with the columns `movements` has at that time. A new
  column needs nothing more. A new link column must stay valid for old rows: categories and accounts are archived,
  never deleted, so do not add a delete for them without changing undo.
- Any new write that deletes or merges away a movement must check `import_rows` and keep the row in `prev` in the
  same batch, as `mergeManualIntoBank` does, or undo loses it. `prev` is a list of full rows.
- Only a card statement's credits are refunds (abono). Money in from anything else is ingreso in Revisar unless the
  row says otherwise. Only the user turns income into a refund.
- `maskDigits` in `public/import/parse.js` and `src/lib/importing.ts` stay the same (a test compares them).
- Rules that sort imported rows (starter rules, Funciones' own) hold generic words only, never anything from
  `~/finanzas/data/`.

## Outside packages vetted, Nov 25 2026

Each tarball came from `npm pack`. Its sha512 matched the registry, and it was unpacked into an empty folder and read
there. Nothing was installed into the app. "Old enough" means published at least 2 weeks ago.

### Tabler Icons 3.51.0 (`icons.svg` on Diseño's branch): OK

- `@tabler/icons@3.51.0`: published Nov 8 2026, MIT, with npm provenance. The tarball sha512 matches the registry and
  Diseño's value (`sha512-0pinvPZz...RGdA/g==`). It has no dependencies and no install scripts. Its only scripts are
  build scripts, and npm does not run those on install.
- `app/public/icons.svg` was checked at commit e8a65a9. The file is byte-identical after the rebase (f4ad4cc).
  - It holds 23 `<symbol>` elements (id, viewBox) with 69 `<path d>` and nothing else.
  - An allowlist check found none of these: script, foreignObject, style, use, image, a, animate or set elements,
    on* attributes, href or xlink:href, `data:`, `javascript:`, `url(`, DOCTYPE or entities.
  - The only `<use>` is a usage example inside the header comment.
- All 23 icons match the path data in the package's own `icons/outline/*.svg` files. The MIT notice is in the header.

### Impeccable checker: OK with the commands below, not with plain `npx impeccable`

Version:
- Use `impeccable@4.8.2` (Nov 9 2026, Apache-2.0) with its engine, `@impeccable/cli-linux-x64@0.1.21` (Nov 9).
- The newest version, 4.11.0, is one day old. Plain `npx impeccable` would fetch it.

Packages:
- Neither package has dependencies or install scripts.
- The npm package is a small Node launcher. The real tool is a 23 MB closed (stripped) Rust binary.
- The binary's sha256 matches the checksum list in the launcher. Neither package has npm provenance, so we are
  trusting the publisher, not a verified build.
- If the engine package is missing, the launcher downloads the binary from GitHub. Installing both tarballs and running
  the binary directly avoids that download.

Telemetry:
- The binary sends anonymous usage data only for its design "roll" feature, a GET to `impeccable.style/api/roll`.
- It also has update and staleness checks.
- Each one has an off switch, and the commands set all of them: `IMPECCABLE_NO_TELEMETRY=1`, `DO_NOT_TRACK=1`,
  `IMPECCABLE_NO_UPDATE_CHECK=1` and `IMPECCABLE_NO_STALENESS_CHECK=1`.

What strace showed, with no off switches set:
- File scans opened no sockets and wrote no files, both with and without a terminal.
- In a URL scan, the binary made one connection, to the local Chrome it starts.
- Chrome runs headless with a new temporary profile (not Melvin's), which is deleted afterwards.
- Chrome itself still called Google hosts (component updates and similar), not with page content. Through the
  `chrome-local.sh` wrapper below, Chrome reached only 127.0.0.1:8790.

Limits:
- Run only `detect`. Never run `impeccable install`, `update`, `link` or `skills`. Those write skills and hooks into
  AI tool settings (`~/.claude` and others), and the binary carries text written to steer AI agents.
- A URL scan sees only signed-out pages: the login screen and the preview's empty state. Never give it a session
  cookie. To check signed-in screens, use a page with made-up numbers.
- Use `/preview`, not `/preview.html`. The redirect makes the scan time out.

Test runs:
- Master's `public/`: 0 findings (rule checks only on .css and .js, so it misses some problems).
- 8790 `/` and `/preview`: 0 findings.
- Diseño's current working copy of `public/`: 4 `undersized-ui-text` findings in `index.html` (the 10px tab bar
  labels). Exit code 2 means "findings", not "error".

If we would rather run no closed binary, the alternative is axe-core run through the Playwright we already have. It is
open source and checks contrast and accessibility, but not Impeccable's design rules.

The commands (bash, Node 22). Delete both folders when done (`rm -rf "$D" "$T"`):

```bash
D=/tmp/claude-1000/-home-melvin/96f7cb17-0b5a-4740-a4bd-d98144994b4b/scratchpad/impeccable
T=/tmp/claude-1000/imp   # Chrome's temp profile: must be a short path (socket names max 108 characters)
mkdir -p "$D/pkg" "$D/home" "$D/out" && mkdir -m 700 -p "$T"
source ~/.nvm/nvm.sh && nvm use 22
cd "$D/pkg"
npm pack impeccable@4.8.2 @impeccable/cli-linux-x64@0.1.21
sha512sum -c <<'EOF'
34210bfce9dd5a3a8280dd6185abb8227ef32c332593f3598a6f087018ad484479ea1c77fde41e7178d10b9fa4495ea245dd9df06e645b04796a0197b1ee1bdf  impeccable-4.8.2.tgz
5fbaff9d09e4da298d179407f2fd2731dadac67902521d1705c8527289583838a6b889decc42a92c03db08c9a14e26e983b1243209df3ee080f3f22f2031a377  impeccable-cli-linux-x64-0.1.21.tgz
EOF
echo '{"private":true}' > package.json
npm install --ignore-scripts --no-audit --no-fund ./impeccable-4.8.2.tgz ./impeccable-cli-linux-x64-0.1.21.tgz
BIN="$D/pkg/node_modules/@impeccable/cli-linux-x64/bin/impeccable"
echo "579a0b6ff639ed28812ae632c556b6524a5b7d13fff4227cd3095a65554415b6  $BIN" | sha256sum -c
cat > "$D/chrome-local.sh" <<'EOF'
#!/bin/sh
exec /usr/bin/google-chrome --host-resolver-rules="MAP * ~NOTFOUND, EXCLUDE 127.0.0.1" --disable-component-update --no-pings --disable-domain-reliability "$@"
EOF
chmod 700 "$D/chrome-local.sh"
imp() { (cd "$D/out" && env -i PATH=/usr/bin:/bin HOME="$D/home" TMPDIR="$T" TERM=dumb \
  IMPECCABLE_BROWSER="$D/chrome-local.sh" IMPECCABLE_NO_TELEMETRY=1 DO_NOT_TRACK=1 \
  IMPECCABLE_NO_UPDATE_CHECK=1 IMPECCABLE_NO_STALENESS_CHECK=1 "$BIN" detect "$@"); }
imp --json http://127.0.0.1:8790/ > "$D/out/root.json"
imp --json http://127.0.0.1:8790/preview > "$D/out/preview.json"
imp --json app/public > "$D/out/files.json"
```

### SimpleWebAuthn (Wave 2 passkeys): OK

Versions:
- `@simplewebauthn/server@14.1.0`: Nov 6 2026, MIT, with provenance.
- There is no browser 14.1.0. Its newest is `@simplewebauthn/browser@14.0.0` (Sep 2 2026, MIT, with provenance, no
  dependencies). Use that pair.

Server dependencies:
- The server pulls in 24 more packages (@peculiar asn1 and x509, tsyringe, reflect-metadata, tslib, asn1js and a few
  others).
- All are MIT, BSD-3-Clause, Apache-2.0 or 0BSD. None has an install script. The newest was published Nov 6.
- npm audit finds 0 problems.

What the server code does:
- No eval, no file access, no environment reads, no telemetry.
- It uses Web Crypto (`globalThis.crypto`), so it runs on Workers without `nodejs_compat`.
- Bundled for Workers it is about 326 KB minified (90 KB gzipped), with no `node:` imports.
- `reflect-metadata` adds functions to the global `Reflect` inside the Worker. That is harmless.

Network from the Worker happens in only two cases:
1. `MetadataService.initialize()` downloads the FIDO list. Do not call it.
2. During registration it may fetch a certificate revocation list (CRL). It does this only after the attestation
   chains to the Apple or Google roots built into the library, so an attacker cannot choose the URL. We ask for
   `attestationType: 'none'`. To guarantee the Worker never fetches, reject any `fmt` other than `none`, or `packed`
   without `x5c`, before verifying.

Serving the browser part:
- Copy `esm/` (20 files, 40 KB) and `LICENSE.md` to `public/vendor/simplewebauthn-browser-14.0.0/`.
- Import `startRegistration` and `startAuthentication` from its `index.js` with a relative path.
- `script-src 'self'` allows this, and same-origin files already meet COEP and CORP.
- The Permissions-Policy does not name `publickey-credentials-get` or `publickey-credentials-create`. Their default is
  self, which is what we want, so do not add them as `()`.

Rules for Wave 2:
- WebAuthn does not accept an IP address as the RP ID, so local tests use `http://localhost:8791`, not 127.0.0.1.
- In production, `rpID` is the exact host and `expectedOrigin` is the exact https origin.
- Challenges are stored on the server, used once, and expire after 5 minutes. Set `requireUserVerification: true`.
- Store the credential id, public key and counter with `user_id`, plus the "same user" and "user_id fixed" triggers.
- Rate limit the passkey endpoints the same way as login. Keep the passphrase as the fallback.

### pdf.js (`pdfjs-dist@6.5.438`): OK

Package:
- Published Nov 1 2026, Apache-2.0, with provenance. The tarball sha512 matches the registry.
- No install scripts. The only dependency is the optional `@napi-rs/canvas`, which is Node-only native code that a
  browser does not need. npm audit finds 0 problems.
- Do not npm install it into the app. Copy the files.

What the code does:
- Version 6 never evaluates strings as code: the builds contain no `new Function` and no `eval(`.
- The old `isEvalSupported` option is gone, so passing it does nothing.
- No telemetry. The only URLs in the code are XML namespace names.
- It fetches only URLs we give it (`url`, `cMapUrl`, `standardFontDataUrl`, `iccUrl`, `wasmUrl`). Pass the file's bytes
  as `data` and leave the others unset. Reading text from Latin-alphabet bank statements does not need them.
- WASM is on by default, and our CSP has no `'wasm-unsafe-eval'`. Pass `useWasm: false`, and do not add
  `'wasm-unsafe-eval'` to the CSP.
- Scripting (QuickJS) and XFA forms are off by default. Keep them off.

Serving from our own files:
- Copy `build/pdf.min.mjs`, `build/pdf.worker.min.mjs` and `LICENSE` to `public/vendor/pdfjs-6.5.438/`
  (`scripts/vendor-pdfjs.sh`, pinned hashes). They are committed; the privacy check pins the two builds by sha256.
- Load the main file with `import()` only on the import screen. Set `GlobalWorkerOptions.workerSrc` to the worker's
  same-origin path.
- pdf.js uses a same-origin worker path directly. It makes a blob: URL only for other origins, and
  `worker-src 'self'` would block that.
- The worker gets our `/*` headers, so it carries COEP `require-corp`, which a COEP page needs.
- With nosniff on, check that the `.mjs` files are served as `text/javascript`. If not, copy them with `.js` names.
- Do not set `rendererSrc` (the new rendering worker). We only read text.

Suggested call: `getDocument({ data, useWasm: false, enableXfa: false, disableFontFace: true, useSystemFonts: false })`,
then `getTextContent()` for each page (Importar adds `verbosity: ERRORS`). Also:
- Cap the file size and page count.
- Keep PDF text out of HTML: use `esc()` or textContent.
- Let the server validate every row, as it does today.

## Wave 1 review: cards and money (Nov 25 2026)

Branch `seguridad-review-w1` (= `fix-cards` 9466b58, parent d254b3f; audit fixes F04, F05, F08, F12, F18, F25, F32,
F33, F35, F36, F38, F40). Verdict: OK to merge after the commit below; no Critical, High or Medium open.

Fixed:
- Low, fixed: `parseRate` read a decimal comma with 3 digits as thousands, the same 100x to 1000x slip F05 was about.
  EUR 9,20 at "0,925" saved $0.01, and CAD "1,385" became 1,385 a dollar. Now a leading 0 is always a decimal comma,
  and one comma with exactly 3 digits ("1,385") is thousands only for COP and refused for the rest ("No se entiende la
  tasa"). The live "Son $x en dólares" line already showed the slip, so it was Low, not Medium.
- Low, fixed: the thousands-dot question ("4.400" for COP) also covered CRC. CRC is about 500 a dollar, so "512.500" is
  512.5: the app told her to type 512500, and an older CRC movement whose rate has exactly 3 decimals could not be saved
  again. Now COP only.
- Process: `sw.js` added `numbers.js` without a CACHE bump (the rule above). CACHE is now `fz-shell-v12`. The worker
  fetches the network first, so nothing was served stale; the list change itself is OK.
- attack.py: bob also tries `DELETE /api/cards/<hers>/statement` (with and without `?st=`) and her statement id inside
  his request; the 423 list has the new DELETE.
Tests: `test/seguridad-w1.test.ts` (7).

Checked, OK:
- Cross-user: `DELETE /cards/:id/statement` checks the card is hers and a card (404) before anything, and both deletes
  name `id`, `user_id` and `account_id`. The `id` in `POST /cards/:id/statement` deletes only `WHERE id = ? AND
  user_id = ? AND account_id = ?`, in one batch with the upsert. Tested: bob gets 404 on her card by every route; his own
  card with her statement id writes only his row and deletes 0; her id on her other card leaves the first card's row
  alone. `?st=` takes 1 to 16 digits (400 otherwise; 9999999999999999 matches nothing, no 500). `id` is a safe
  integer of 1 or more (zod: 0, -1, 1.5, "1", 1e20, 2^53, true, lists and objects are 400).
- The new DELETE is behind `requireUser` and `requireUnlocked` (the every-route 423 test picks it up by itself). A wipe
  needs no fresh check: it removes card dates only and movements never change.
- Manual statements now replace (an emptied field is cleared); the email and import path keeps COALESCE. The client
  checks every field before the first request (F32), and empties go through the DELETE (F04).
- F08: `lastClosing` takes the scheduled closing unless a known one falls within 10 days before it or later; the cycle
  sum now ends at today. F12: one due date per cycle (10 days), so no second "vence hoy". F40: `amount_cents` 1 or more
  on PUT, and `fxColumns` refuses a zero base with 400 before dividing.
- `numbers.js` has no imports and no page access. `parseCents`: other currencies up to 1e14 (same as the server),
  dollars keep $100,000; zero only where `zero: true` (statement payments, limits, the Wise fee); a typed fee that does
  not read is an error (F36). The rate is shown to 6 decimals, so opening and saving keeps it (F35). The USD line is
  set with `textContent`; error values (`{x}`) are digits or `money()`.
- Every new string is in es and en (9 keys each), in tú; card names go through `esc()` after `t()`. No inline style
  or handler; the wipe button is `type="button"` with the two-tap confirm.

Not changed, for the lead: a wipe keeps the card's import closing dates (`imports.period_end`), so Tarjetas still
shows a cycle for a card with imports. That is real data, not a statement, and it sends no reminder (no due date).

Results: type check clean; 227 tests pass (220 on the branch, 7 new); `scripts/git-privacy-check.sh` clean;
`FZ_ATTACK_PORT=8791 scripts/attack.sh`: 145 of 145 on 9466b58 and 145 of 145 after the fixes (bob now refused on 23 tries, the 423 list has 70 routes).

## Wave 2 review: import (Nov 25 2026)

Branch `seguridad-review-w2` (= `fix-import` d80d40d, parent 9466b58; audit fixes F01, F02, F03, F09, F10, F20, F21,
F22, F50, F51, F53, F54, F55, F56). Verdict: OK to merge after the commit below; no Critical or High open.

Fixed:
- Medium, fixed: the part claim was its own write before the part's batch, and a failure took it back. When D1 saves
  the batch but its answer is lost (or the Worker stops between the two writes), the claim and the rows disagree.
  Shown: a lost answer gave a 500, the part was taken back, and the retry on the same import (which `importar.js` now
  does by itself) saved every row twice (2 rows became 4). Now the claim is the first statement of the part's batch:
  `parts = CASE WHEN parts = ? AND status = 'open' THEN parts + 1 END`, so a taken part or an undone import makes
  parts NULL, the NOT NULL rule refuses it and the whole part rolls back. On an error the route reads the import again:
  undone is 409, a part already counted is `duplicate_part`. This also stops a part from landing on an import that
  was undone while it was being saved, and a later part from running next to an earlier one.
- Low, fixed: after the undo hand-over (F03) the newer import kept "2 ya estaban" in the history while it now owns the
  rows as added or merged. Undo now recounts every import that took rows over.
- Low, fixed: on a key collision (nothing inserted, nothing merged) the shop rule was still learned from the typed
  row's category. The old merge learned nothing then. The rule is now written only when this part wrote the row.
- Low, fixed (screen): undoing a half-saved import from the history left its file pointing at the undone import, so
  every Guardar after that was a 409. Now that file starts a new import. Picking another file asks the "Guardar sin
  esas líneas" second tap again.
- attack.py: it still expected a wallet "REFUND" line to be a refund (abono). Under F09 it is income waiting in Revisar,
  so the check and the totals now say so (that was the 2 of 145 that failed on d80d40d).
Tests: `test/seguridad-w2.test.ts` (8; 5 of them fail on d80d40d).

Checked, OK:
- The one-batch merge matches the old `mergeManualIntoBank`: category (typed first), note, tags (no repeats), estado,
  other-currency amount with `mergedRate`, fee cleared, Personas lines moved, the typed row's suggestions removed,
  shop rule from the typed category, and the typed row kept whole on this import's row. Undo brings it back equal to
  before, with its Personas lines (tested column by column). One difference on purpose: a typed row with no category
  no longer teaches the starter rule's category.
- Every statement names `user_id`; the typed rows are read with `user_id` and `origen = 'manual'`. The typed row is
  deleted, its lines moved and its suggestions removed only under `EXISTS` on this part's `dedupe_key` and `raw` (raw
  names the import), so a key collision never touches the typed row (tested).
- Undo hand-over: heirs come only from this user's import rows of kind 'already', on imports that are not undone, and
  the update names `id` and `user_id`. Another user's import can never point at her rows (the same-user triggers), and
  bob still gets 404 on her undo. Two newer imports: the newest takes it; undoing that one hands it to the next; an
  import undone first is skipped. The typed copy (prev) travels with the hand-over, because an 'already' row never
  has its own prev.
- planRows: F01 (a row from a statement or file counts only on the same date), F10 (only a typed gasto merges),
  tipoOf/askIn (only card credits are refunds). review.ts reads the suggestion rows with a `user_id` subquery in every
  part (F21). steps.ts counts 'archivo CSV' (F53).
- Readers: unreadable split cells are bad lines, one balance is no proof, bad lines turn a green check into "Faltan
  líneas" and need a second tap; UglyCash without "Balance on" is no_balance; references need a digit; chunks count
  UTF-8 bytes; the preview ticket drops old answers. A CSV footer line with no date now also asks the second tap; that
  is the safe side.
- Screens: line numbers and every new string go through `esc()`; Revisar's "Ingreso" and "Reembolso" buttons send only
  `tipo` (and `estado: ok` for income). All new keys exist in es and en, in tú.

Not changed, for the lead: two uploads of different statements of the same account running at the same moment could
both merge the same typed row (each bank row gets its category and note). It needs two saves in flight at once, and
undo still brings the typed row back only once.

Results: type check clean; 242 tests pass (234 on the branch, 8 new); `scripts/git-privacy-check.sh` clean;
`FZ_ATTACK_PORT=8791 scripts/attack.sh`: 143 of 145 on d80d40d (the F09 expectation above), 146 of 146 after (new check:
the same part 6 times at once saves once, a skipped part and a part after undo are refused).

## Wave 3 review: sign-in and sessions (Nov 25 2026)

Seguridad reviewed e6c11bd (F06, F07, F28, F29, F47) on branch seguridad-review-w3. Verdict: OK with two fixes.

Fixed:
- Medium: removing the last Face ID that still works left the lock on. passkeys_last_removed only looks at whether
  any passkey row is left, and after a backup-code sign-in the old Face ID stays listed but no longer works (F07). So
  backup sign-in, new Face ID, lock on, remove the new Face ID: lock on, /unlock/options 409, Face ID sign-in refused.
  DELETE /passkeys/:id now turns the lock off in the same batch when no counting passkey (PK_COUNTS) is left, and
  answers app_lock false (tested, fails on e6c11bd).
- Low: keepPush re-sends whatever subscription the browser still holds, for whoever is signed in. After one person
  signs out on a phone, the next person who signs in there got alerts she never turned on (and the first person was
  then refused as "taken"). Signing out here (Ajustes, the lock screen, "cerrar todas") now ends the browser's
  subscription (hooks.dropPush). A session that ends elsewhere keeps it, so F29 still works for the same person.
  localStorage still holds only the theme.

Checked and fine:
- Every path that writes a proof names its method: /login (backup: passphrase), /login/password (password),
  /login/passkey and /unlock (passkey, only a passkey made after backup_used_at), /reauth (password or passphrase,
  only the one freshMethod asks for). isFresh and freshMethod agree. A password proof carried past adding a Face ID is
  not fresh (tested). Invite sign-up and reset links make no proof.
- NULL method (sessions from before 0006): opens the lock, never fresh, so the page asks once (tested).
  rotateSession runs only after requireFresh, so it never sees a NULL proof; if it did, the new session would be
  locked, the safe side.
- Math.min(unlockedAt, now): right; the carried time is never in the future and the 12 h lock window also counts from
  the real check.
- Batch order: the change (its trigger deletes every session, push_subs goes by ON DELETE CASCADE), cleanup, the new
  session, then the push rows. The re-insert comes after the cascade (tested: one row, new session, old session gone).
  The rows are read with user_id and this session's hash, and the upsert only updates a row of the same user, so
  another person's row is never touched (tested). A subscription turned off before the change is not read, so not
  brought back (tested). Left: a DELETE /push/subscription sent at the same moment as the change could come back; it
  needs two requests in flight at once from the same phone.
- fnPushOff ends the browser subscription, so keepPush cannot turn alerts back on after it (if unsubscribe fails,
  they could come back on the next load; rare).
- deploy-wave2.sh: bash -n clean; `${KNOWN% 0007_budget.sql}` is the first six names; both checks fail closed. The
  0007 name is a guess: if the budget migration is named differently the script stops before changing anything.
- New sw.js modules: none (cache stays fz-shell-v12; network first, so the changed files reach phones).

Results: type check clean; 252 tests pass (246 on the branch, 6 new in test/seguridad-w3.test.ts);
`FZ_ATTACK_PORT=8795 scripts/attack.sh` 146 of 146; `scripts/git-privacy-check.sh` clean.

## Seguridad review: Wave 4, screens and navigation (Nov 25 2026)

Reviewed `git diff 4183a87..f760d44` (aee7ed4, f760d44: F15, F17, F19, F23, F24, F26, F27, F30, F31, F34, F37, F42, F43,
F44, F52, and Movimientos rows with only the payment method under the title). Verdict: safe to ship with the fixes below.
No XSS, no data in the cache, nothing new reaches the server.

Problems found:
- Medium, fixed (guard): the service worker now serves the shell cache first and only takes new files when sw.js
  changes. A deploy that changes a shell file but forgets to change CACHE would leave every installed iPhone on the old
  files for good, next to a newer server. New `scripts/shell-check.mjs`: deploy.sh and deploy-wave2.sh run it before
  the token prompt. It reads the live sw.js; same CACHE is allowed only when every shell file and the page's CSP are
  byte for byte the live ones, else nothing is published. A new CACHE passes. If the live app cannot be read it asks
  for "yes". The same parser now feeds test/sw-shell.test.ts.
- Medium, fixed: F15 set `S.boot = null` before reloading the start data. Code still running from the screen before
  could read the null, and after an hour with no signal the app showed a dead error instead of the screen. Now the old
  data stays while it loads. On failure, an hour-old copy from the same day still draws. A copy from an earlier day
  shows the Reintentar screen as before, so yesterday is never shown as today.
- Low, fixed: wake() (back online, app opened again) redrew any screen when the start data was old. A form she had
  filled and left (Agregar halfway, then a look at another app) was wiped. Now a screen with edited fields only gets
  the start data reloaded behind it. Untouched screens are drawn again as before.
- Low, fixed: F34 drops an edited row that no longer fits the filter, but the paging offset stayed, so "Cargar más"
  skipped one row. The offset now goes back by one (duplicates were already dropped by id).

Checked, OK:
- sw.js: /api/* and every non-GET or cross-origin request go straight to the network. Only exact SHELL paths with no
  query are stored. A miss stores only ok, same-origin, unredirected answers. Non-shell navigations go to the network
  and fall back to the cached "/". The install takes the whole set at once with cache "reload". Activate deletes the
  other fz-shell caches. In Chromium the cache held exactly one fz-shell-v12 with the shell, no /api and no query
  address. A page can still mix versions in one case: /import/*.js (not in SHELL) comes from the network, so an old
  importar.js could load new readers in the first session after a deploy. Low; adding /import/ to SHELL would close it.
- boot-check.js: a classic same-origin script (script-src 'self'), textContent only, no inline style, and it deletes
  only caches named fz-shell-*. Tested with ui.js blocked: the message shows after 8 s, there is no CSP report,
  Recargar clears fz-shell-* (another cache stays) and the app opens.
- Router: scroll restore by history index with manual restoration. The lit tab uses history.back only when the screen
  came from the tab root, else location.replace, so it never adds a step. The popstate with hasUAVisualTransition sets
  "none". Tested in Chromium: back to Más lands on the same scrollY, and history.length does not grow.
- mas.js keeps nodes only while the markup is identical. Listeners are delegated on document, so nothing leaks.
  `CSS.escape(S.from)` keeps the hash out of the selector. setBadge touches only the tab badge.
- F19 loading guard, F17 late and stale suggestion, F52 nav guards, F37 real amount in tooltip and label: all OK.
  movRow short: title and account go through esc(). tn(): every key has its 1 and N forms. es and en have the same
  673 keys, and the new Spanish uses tú. The datehint label goes through esc(). The date CSS uses :has (iOS 15.4+)
  and ::-webkit-date-and-time-value. It was checked in Chromium only, since WebKit cannot run here.
- Not in this wave: es `pwAgain: "Repetila"` is voseo (tú: "Repítela").

Tests: test/sw-shell.test.ts has 5 new tests (guard logic, and both deploy scripts call it before the token). attack.py
has a new "Wave 4 screens" part (6 checks: short rows, paging after an edit, wake on a touched and an untouched
screen, new day offline). Against f760d44, the paging, wake-form and new-day checks fail.
Results: tsc clean; vitest 255 of 255; `FZ_ATTACK_PORT=8796 scripts/attack.sh` 152 of 152 (146 of 146 before);
git-privacy-check clean.

## Wave 5 review: alerts, recurring, Personas edits (Nov 25 2026)

Seguridad reviewed acf8e6c and 7fa2d32 (F11, F13, F14, F16, F39, F41, F45, F46) on branch seguridad-review-w5 (the
merge c6ac618 between them was reviewed before). Verdict: OK to merge with two small fixes (839cb71).

Fixed:
- Low: a "Saldar" line kept its old amount when its transfer (tipo interno) was edited, the same stale balance F14
  fixed for they-paid lines. PUT /movements now also moves a settle line to the new amount in the same batch (money
  in stays negative, out positive). Tested in test/seguridad-w5.test.ts, fails on 7fa2d32.
- Low: F39 kept an archived category, but not a live category inside an archived group (activeCats leaves those out
  too), so the sheet still showed "Ninguna" and a save cleared it. data.js catsWith/accountsWith add the rule's own
  one whatever the reason it is hidden; recurrentes.js uses them. Tested.

Checked and fine:
- Every new query filters by user_id: the person_entries read and updates, the push_log claim and its DELETE, the
  alert_marks writes, the months-with-data query, both recurring charge queries.
- F11: the DELETE names this run's sent_at. Another run can claim only after that DELETE ran (before it, its INSERT
  conflicts and it reports capped), so a run never removes another run's claim, even two cron runs with the same
  scheduledTime. Tested: two runs at once, one 503 and one 201, then two more runs: exactly one push taken, one claim.
  All subscriptions 404/410: they go and the claim goes. Marks only after a 2xx.
- F14: the check runs only when amount or tipo changes, so shop, note, category, date, tags and account edits pass
  (tested), and the edit sheet sends the saved amount and tipo back unchanged. A they-paid purchase's amount can be
  raised (its line follows) and lowered while it stays at or above any shares. Merges move lines between rows of the
  same amount, so they are not touched. Another user's movement is a 404 before the check, so the 409 and its
  shares_cents are only ever her own (tested). Review's "Es reembolso" shows the 409 text through errText.
- F13: a they-paid purchase (no account) never pays a rule tied to an account; a rule with no account still matches
  any; callers without account_id keep the old behavior.
- F16: an untouched date is not sent and PUT keeps the stored anchor; a changed date still moves it.
- F41: with no gaps the last 3 full months are the same as before; the spending range from the first to the last
  chosen month only adds empty months, so the sums match the chosen months. 400 days covers the 12 months looked at.
- F46: 12 placeholders in order; a first-time race inserts once and the second only COALESCEs its own switch.
- F45 and F14 texts: es and en have the same keys, Spanish in tú form.
- sw.js: no new modules, cache stays fz-shell-v12 (Deploy 1 not yet live).

Results: type check clean; 260 tests pass (256 on 7fa2d32, 4 new in test/seguridad-w5.test.ts);
`FZ_ATTACK_PORT=8798 scripts/attack.sh` 146 of 146; `scripts/git-privacy-check.sh` clean.

## Deploy 2 review: Wave 6, group colors, glass hero, weekly mode (Nov 26 2026)

Seguridad reviewed bb66952 (F48, F49), 3251d6f, 6056cc5 and f539413 (weekly "Te quedan", migration 0007, sw v13)
against master on branch seguridad-review-d2. Wave 5 was reviewed before. Verdict: OK to deploy with the two fixes
below (0b43ff8), using `deploy-wave2.sh`.

Fixed:
- Medium: Deploy 2 needs migration 0007 (budget_prefs). /bootstrap, /home/extras and the evening alert job all read
  that table, so new code on a database without it fails on every screen and in the cron. README said "later releases
  use deploy.sh", and deploy.sh never applies migrations. deploy.sh now lists the live migrations after the token
  check and stops before publishing when one is pending, saying to run deploy-wave2.sh (which bookmarks, applies,
  then publishes). Tested in test/seguridad-d2.test.ts (fails on f539413).
- Low: the glass box commit removed `.summary .hero`, so the Personas person page number shrank from 48 px to 36 px.
  The rule is back; the boxed rule still wins on Home only. Tested (app.css read through ASSETS) and in the browser.

Checked and fine:
- Every new query filters by user_id (budget_prefs read and upsert, week.ts groups, categories, recurring,
  movements). The zod body is strict; 9 bad bodies 400, another site 403, no session 401; bob's row never touches
  alice (tested and in attack.py).
- No budget row: /summary and /home/extras are byte for byte the same (tested while another user turns weekly on);
  Home and Análisis draw as before (Monday weeks); the weekly alert stays on Sunday. Week start 0 sends it Saturday.
- Query load: one extra read per Home load with no row, five with a weekly row; the alert job adds a subquery inside
  an existing statement, so its batch keeps 6 statements per person.
- Week math: start 0 to 6, weeks across months and years, today counts as day 1..7, derivedWeek per day per month,
  whole dollars, never negative; a refund bigger than spending gives a negative spend (shown as more left), no crash;
  a rule whose next_date is after the month adds nothing to that month, the same as monthly mode.
- deploy-wave2.sh accepts 0007_budget.sql in both checks; shell-check.mjs with master as the live copy says "new
  version" for v13 (and would stop on 11 changed shell files without the bump).
- F49 SQL: changes() counts only the UPDATE's own rows (not the session trigger); the NOT NULL insert can never add a
  row. F48: real ledger keys unchanged.
- XSS: new strings and options go through esc(); tHtml gets only money. es and en have 698 keys each, same
  placeholders, Spanish in tú. Group colors: classes from the fixed palette, set through the DOM.
- 320 px (headless Chrome): the glass box and its number fit for weekly $99,999 (is-long), weekly from limits and
  monthly; no page scroll, nothing spills out of the box. After saving Tu presupuesto, Home shows the week at once.

Results: type check clean; 282 tests pass (277 on f539413, 5 new in test/seguridad-d2.test.ts);
`FZ_ATTACK_PORT=8799 scripts/attack.sh` 157 of 157 (5 new Deploy 2 checks); `scripts/git-privacy-check.sh` clean.
