#!/usr/bin/env bash
# Publish the Funciones release (Personas, Tarjetas, Recurrentes, Alertas, Moneda, Face ID reset rules) to the live app.
# Melvin runs this himself, in his own terminal window, NOT through Claude:
#
#     cd ~/finanzas/app && bash scripts/deploy-wave2.sh
#
# What it does, in order, stopping at the first error:
#   1. Saves a D1 Time Travel bookmark of the live database (the point to go back to) and prints the restore command.
#   2. Applies the database migrations the live app does not have yet (0003 to 0007: new tables and columns only;
#      0006 adds sessions.unlock_method for the audit fixes, 0007 the weekly budget table when it exists).
#      Wrangler asks "continue? (Y/n)" first; that question stays on screen.
#   3. Makes the Web Push key pair, only when the live app has no VAPID_PRIVATE_KEY secret yet.
#   4. Publishes the code (this also turns on the evening cron, 7 pm El Salvador), then prints what to check.
#
# It asks for the Cloudflare API token (Workers Scripts Edit + D1 Edit only) without showing it and keeps it only
# inside this script's process (not in shell history, not in any file). The private push key is never printed.
# Running it again is safe: an applied migration is skipped, an existing push key is kept.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -t 0 ] || [ ! -t 1 ]; then
  echo "Run this in your own terminal window, not through Claude or a pipe." >&2
  exit 1
fi

set +u  # nvm does not work with set -u
source "$HOME/.nvm/nvm.sh" >/dev/null
nvm use >/dev/null
set -u

PROD=wrangler.production.jsonc
UUID='"database_id": *"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"'
if [ ! -f "$PROD" ] || grep -q "00000000-0000-4000-8000-000000000000" "$PROD" || ! grep -Eq "$UUID" "$PROD"; then
  echo "$PROD is missing or has no live database id. Nothing was changed. Tell Claude." >&2
  exit 1
fi
ORIGIN="$(grep -Eo '"APP_ORIGIN": *"[^"]*"' "$PROD" | sed -E 's/.*"([^"]*)"$/\1/')"
RPID="$(grep -Eo '"RP_ID": *"[^"]*"' "$PROD" | sed -E 's/.*"([^"]*)"$/\1/')"
if ! [[ "$ORIGIN" =~ ^https://[a-z0-9-]+(\.[a-z0-9-]+)+$ ]] || [ "$ORIGIN" != "https://$RPID" ]; then
  echo "$PROD needs APP_ORIGIN = the live https address and RP_ID = its host name. Nothing was changed. Tell Claude." >&2
  exit 1
fi
# This release needs the push key line (step 3 fills it) and the evening cron.
if ! grep -Eq '"VAPID_PUBLIC_KEY": *"[A-Za-z0-9_-]*"' "$PROD" || ! grep -Eq '"crons": *\[ *"0 1 \* \* \*" *\]' "$PROD"; then
  echo "$PROD has no VAPID_PUBLIC_KEY line or no evening cron (\"0 1 * * *\"). Nothing was changed. Tell Claude." >&2
  exit 1
fi
# The migrations this script knows, in order. migrations/ must hold the first 6 or all 7 of them, nothing else.
KNOWN="0001_init.sql 0002_security.sql 0003_accounts.sql 0004_import.sql 0005_features.sql 0006_unlock_method.sql 0007_budget.sql"
HAVE="$(cd migrations && ls -1 *.sql | tr '\n' ' ' | sed 's/ $//')"
if [ "$HAVE" != "${KNOWN% 0007_budget.sql}" ] && [ "$HAVE" != "$KNOWN" ]; then
  echo "migrations/ does not hold exactly 0001 to 0006 (or 0007). Nothing was changed. Tell Claude." >&2
  exit 1
fi
if ! bash scripts/vendor-pdfjs.sh --check >/dev/null; then
  echo "public/vendor/pdfjs-6.5.438 is missing a file or is not the vetted build. Nothing was changed. Tell Claude." >&2
  exit 1
fi
# F42 (Seguridad): the phones keep the app's files until public/sw.js changes; a changed shell under the same CACHE
# name would never reach them (scripts/shell-check.mjs).
set +e
node scripts/shell-check.mjs "$ORIGIN"
SHELL_RC=$?
set -e
if [ "$SHELL_RC" = 1 ]; then
  echo "Nothing was changed. Tell Claude: the shell changed but CACHE in public/sw.js did not." >&2
  exit 1
elif [ "$SHELL_RC" != 0 ]; then
  read -r -p "Could not compare with the live app. Go on anyway? Type yes: " ANSWER
  if [ "$ANSWER" != "yes" ]; then
    echo "Nothing was changed." >&2
    exit 1
  fi
fi

if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  read -rs -p "Cloudflare API token (hidden): " CLOUDFLARE_API_TOKEN
  echo
fi
if [ -z "$CLOUDFLARE_API_TOKEN" ]; then
  echo "No token typed. Nothing was changed." >&2
  exit 1
fi
# Only that token: a Global API Key left in this window would win over it (wrangler checks the key first).
unset CLOUDFLARE_API_KEY CLOUDFLARE_EMAIL CF_API_KEY CF_EMAIL CF_API_TOKEN CF_ACCOUNT_ID
CLOUDFLARE_ACCOUNT_ID=7eb1d4cdfe91e9aab3d169cb8520fb79
export CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID
export WRANGLER_SEND_METRICS=false
export WRANGLER_NO_SKILLS_UPDATE_PROMPTS=true

WR="npx --no-install wrangler"
STEP="0/4 checking the token"
DONE="nothing was changed"
trap 'echo; echo "STOPPED at step $STEP. So far: $DONE. Nothing after it ran. Copy this message to Claude." >&2' ERR

echo
echo "0/4  Checking the token..."
$WR whoami

echo
STEP="1/4 Time Travel bookmark"
echo "1/4  Saving the database's current point (Time Travel bookmark)..."
TT="$($WR d1 time-travel info finanzas --json -c "$PROD")"
BOOKMARK="$(printf '%s' "$TT" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const m=s.match(/\{[\s\S]*\}/);const b=m&&JSON.parse(m[0]).bookmark;if(typeof b!=="string"||!/^[0-9a-f-]{20,}$/.test(b))process.exit(1);process.stdout.write(b)})')" || {
  echo "Could not read a bookmark from wrangler's answer. Nothing was changed. Copy this message to Claude." >&2
  trap - ERR
  exit 1
}
echo "     Bookmark: $BOOKMARK"
echo "     To put the database back to this point (only if a migration below goes wrong; it also undoes anything"
echo "     saved after it), run in this folder with the same token:"
echo "       npx wrangler d1 time-travel restore finanzas --bookmark=$BOOKMARK -c $PROD"
DONE="bookmark saved (database unchanged)"

echo
STEP="2/4 database migrations"
echo "2/4  Database migrations the live app does not have yet:"
LIST="$($WR d1 migrations list finanzas --remote -c "$PROD")"
PENDING="$(printf '%s\n' "$LIST" | { grep -Eo '[0-9]{4}_[a-z_]+\.sql' || true; } | sort -u | tr '\n' ' ' | sed 's/ $//')"
for m in $PENDING; do
  case "$m" in
    0003_accounts.sql|0004_import.sql|0005_features.sql|0006_unlock_method.sql|0007_budget.sql) ;;
    *)
      echo "     The live database is missing $m, which it should already have. Is this the right database?" >&2
      echo "     Nothing was changed after the bookmark. Copy this message to Claude." >&2
      trap - ERR
      exit 1 ;;
  esac
done
if [ -z "$PENDING" ]; then
  echo "     none (already applied)"
else
  echo "     $PENDING"
  echo "     They add tables, columns and checks; no existing row is changed. Answer Y to the question below."
  $WR d1 migrations apply finanzas --remote -c "$PROD"
  AFTER="$($WR d1 migrations list finanzas --remote -c "$PROD")"
  if printf '%s\n' "$AFTER" | grep -Eq '[0-9]{4}_[a-z_]+\.sql'; then
    echo "     Some migrations are still not applied (did you answer n?). The code was NOT published." >&2
    trap - ERR
    exit 1
  fi
  DONE="bookmark saved, migrations applied (the live app still runs the old code, which ignores the new tables)"
fi

echo
STEP="3/4 Web Push key"
echo "3/4  Web Push key..."
SECRETS="$($WR secret list -c "$PROD" --format json)"
HAS_KEY="$(printf '%s' "$SECRETS" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const m=s.match(/\[[\s\S]*\]/);if(!m)process.exit(1);process.stdout.write(JSON.parse(m[0]).some(x=>x&&x.name==="VAPID_PRIVATE_KEY")?"yes":"no")})')"
PUB="$(grep -Eo '"VAPID_PUBLIC_KEY": *"[^"]*"' "$PROD" | sed -E 's/.*"([^"]*)"$/\1/')"
if [ "$HAS_KEY" = "yes" ] && [ -n "$PUB" ]; then
  echo "     The live app already has its push key; kept."
elif [ "$HAS_KEY" = "yes" ]; then
  echo "     The live app has a private push key, but $PROD has no public key. They must be a pair." >&2
  echo "     If no phone has alerts on yet, make a new pair:  node scripts/vapid-keys.ts --live" >&2
  echo "     (with the token exported in this window), then run this script again. The code was NOT published." >&2
  trap - ERR
  exit 1
else
  node scripts/vapid-keys.ts --live
  echo "     (This script publishes next; no need to run deploy.sh.)"
  DONE="$DONE; push key made (wrangler.production.jsonc now holds the public key: commit it)"
fi

echo
STEP="4/4 publishing"
echo "4/4  Publishing the app (and the evening cron)..."
$WR deploy -c "$PROD"
trap - ERR

echo
echo "Done. The live app runs the Funciones release."
echo "Check now, on the iPhone:"
echo "  1. Close Finanzas fully and open it again from the Home Screen (twice if the old look still shows)."
echo "  2. Sign in. Home shows this month's numbers as before; Más shows Personas, Tarjetas and Recurrentes."
echo "  3. Ajustes, Alertas: \"Activar alertas\", allow, then \"Enviar una prueba\": a notification arrives."
echo "  4. Tomorrow after 7 pm: an evening alert arrives only if something is due (a card, a limit, the week)."
if git status --porcelain -- "$PROD" 2>/dev/null | grep -q .; then
  echo "  5. Commit $PROD (it now holds the public push key):  git commit -m \"Live push key\" -- $PROD"
fi
echo "Keep the bookmark line above for a few days. Tell Claude \"deployed\" so it can run the live checks."
