#!/usr/bin/env bash
# First live deploy of Finanzas. Melvin runs this himself, in his own terminal window, NOT through Claude:
#
#     cd ~/finanzas/app && bash scripts/deploy-first.sh
#
# It asks for the Cloudflare API token (Workers Scripts Edit + D1 Edit only) without showing it, keeps it
# only inside this script's process (not in shell history, not in any file), and shows the live passphrase
# once on the screen only. Safe to run again: steps already done are skipped.
# Wrangler asks a few yes/no questions on the way (apply migrations, run SQL): answer yes. If it asks to
# register a workers.dev subdomain, type the name you picked; it is final (Face ID logins are tied to it).
#
# Local dev keeps using wrangler.jsonc (placeholder database id, so the local database is untouched).
# The live database id goes into wrangler.production.jsonc, which every live command uses with -c.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -t 0 ]; then
  echo "Run this in your own terminal window, not through Claude or a pipe." >&2
  exit 1
fi

set +u  # nvm does not work with set -u
source "$HOME/.nvm/nvm.sh" >/dev/null
nvm use >/dev/null
set -u

if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  read -rs -p "Cloudflare API token (hidden): " CLOUDFLARE_API_TOKEN
  echo
fi
if [ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
  read -r -p "Cloudflare account id (32 letters/numbers, from the dashboard home): " CLOUDFLARE_ACCOUNT_ID
fi
export CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID
export WRANGLER_SEND_METRICS=false

WR="npx --no-install wrangler"
PROD=wrangler.production.jsonc

echo
echo "1/6  Checking the token..."
$WR whoami

echo
echo "2/6  Live database..."
db_id() {
  $WR d1 list --json 2>/dev/null | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      const j = JSON.parse(s.slice(s.indexOf("[")));
      const db = j.find((d) => d.name === "finanzas");
      process.stdout.write(db ? db.uuid : "");
    });'
}
ID="$(db_id)"
if [ -z "$ID" ]; then
  $WR d1 create finanzas --location enam >/dev/null
  ID="$(db_id)"
fi
if ! [[ "$ID" =~ ^[0-9a-f-]{36}$ ]]; then
  echo "Could not read the database id. Stop here and tell Claude what wrangler printed above." >&2
  exit 1
fi
sed "s/00000000-0000-4000-8000-000000000000/$ID/" wrangler.jsonc > "$PROD"
echo "     database finanzas ready (id saved in $PROD)"

echo
echo "3/6  Tables (migrations)..."
$WR d1 migrations apply finanzas --remote -c "$PROD"

USERS="$($WR d1 execute finanzas --remote -c "$PROD" --json --command "select count(*) as n from users" 2>/dev/null \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s.slice(s.indexOf("[")));process.stdout.write(String(j[0].results[0].n))})')"

if [ "$USERS" = "0" ]; then
  echo
  echo "4/6  Your live login. The passphrase shows ONCE below: save it in your iPhone Passwords app now."
  node scripts/add-user.ts melvin "Melvin" ../data/user-melvin-live.sql --no-defaults
  read -r -p "Saved the passphrase? Press Enter to continue. " _
  $WR d1 execute finanzas --remote -c "$PROD" --file ../data/user-melvin-live.sql
  rm -f ../data/user-melvin-live.sql

  echo
  echo "5/6  Your data (1,672 movements, accounts, groups, limits, shop memory)..."
  $WR d1 execute finanzas --remote -c "$PROD" --file ../data/seed.sql
else
  echo
  echo "4/6 and 5/6  A user already exists in the live database: login and data steps skipped."
fi

echo
echo "6/6  Publishing the app..."
$WR deploy -c "$PROD"

echo
echo "Done. Open the workers.dev address above on your iPhone in Safari, sign in as melvin,"
echo "then Share > Add to Home Screen. Tell Claude \"deployed\" so it can run the live checks."
echo "You can now delete the token in Cloudflare (My Profile > API Tokens) or let it expire."
