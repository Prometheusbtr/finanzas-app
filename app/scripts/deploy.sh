#!/usr/bin/env bash
# Publish a new version of Finanzas (code and screens only; the live database is not touched).
# Melvin runs this himself, in his own terminal window, NOT through Claude:
#
#     cd ~/finanzas/app && bash scripts/deploy.sh
#
# It asks for the Cloudflare API token (Workers Scripts Edit + D1 Edit only) without showing it and keeps it
# only inside this script's process (not in shell history, not in any file).
# New database migrations are NOT applied here: when a release needs one, Claude says so and gives that step.
# Seguridad (Deploy 2 review): it refuses to publish while the live database lacks a migration in migrations/
# (new code reading a table that is not there yet fails on every screen). Run deploy-wave2.sh for those.
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

PROD=wrangler.production.jsonc
# A real database id, not the local placeholder. Without one, wrangler 4 makes a NEW empty database on deploy
# (automatic provisioning is on by default) and points the live app at it.
UUID='"database_id": *"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"'
if [ ! -f "$PROD" ] || grep -q "00000000-0000-4000-8000-000000000000" "$PROD" || ! grep -Eq "$UUID" "$PROD"; then
  echo "$PROD is missing or has no live database id. Stop here and tell Claude." >&2
  exit 1
fi
# Face ID and invite links: the live origin and RP ID, exact and https, never local dev's http://localhost
# (deploy-first.sh builds this file from wrangler.jsonc, which holds the local values).
ORIGIN="$(grep -Eo '"APP_ORIGIN": *"[^"]*"' "$PROD" | sed -E 's/.*"([^"]*)"$/\1/')"
RPID="$(grep -Eo '"RP_ID": *"[^"]*"' "$PROD" | sed -E 's/.*"([^"]*)"$/\1/')"
if ! [[ "$ORIGIN" =~ ^https://[a-z0-9-]+(\.[a-z0-9-]+)+$ ]] || [ "$ORIGIN" != "https://$RPID" ]; then
  echo "$PROD needs APP_ORIGIN = the live https address and RP_ID = its host name. Stop here and tell Claude." >&2
  exit 1
fi

# The vetted pdf.js build must be the one published (statement upload reads PDFs with it).
if ! bash scripts/vendor-pdfjs.sh --check >/dev/null; then
  echo "public/vendor/pdfjs-6.5.438 is missing a file or is not the vetted build. Nothing was published. Tell Claude." >&2
  exit 1
fi

# F42 (Seguridad): the phones serve the app's files from their own copy and only take new ones when public/sw.js
# changes. A changed shell file under the same CACHE name would never reach them, so compare with the live app first.
set +e
node scripts/shell-check.mjs "$ORIGIN"
SHELL_RC=$?
set -e
if [ "$SHELL_RC" = 1 ]; then
  echo "Nothing was published. Tell Claude: the shell changed but CACHE in public/sw.js did not." >&2
  exit 1
elif [ "$SHELL_RC" != 0 ]; then
  read -r -p "Could not compare with the live app. Publish anyway? Type yes: " ANSWER
  if [ "$ANSWER" != "yes" ]; then
    echo "Nothing was published." >&2
    exit 1
  fi
fi

if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  read -rs -p "Cloudflare API token (hidden): " CLOUDFLARE_API_TOKEN
  echo
fi
# No token: wrangler would open a browser login with full account access and keep it on disk. Refuse instead.
if [ -z "$CLOUDFLARE_API_TOKEN" ]; then
  echo "No token typed. Nothing was published." >&2
  exit 1
fi
# Only that token: a Global API Key left in this window would win over it (wrangler checks the key first).
unset CLOUDFLARE_API_KEY CLOUDFLARE_EMAIL CF_API_KEY CF_EMAIL CF_API_TOKEN CF_ACCOUNT_ID
# Always Melvin's account. The id is not a secret (it shows in every dashboard URL); an account id left in
# this window from other work cannot send Finanzas somewhere else.
CLOUDFLARE_ACCOUNT_ID=7eb1d4cdfe91e9aab3d169cb8520fb79
export CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID
export WRANGLER_SEND_METRICS=false
export WRANGLER_NO_SKILLS_UPDATE_PROMPTS=true  # no offer to write Cloudflare skills into AI tool settings

WR="npx --no-install wrangler"

echo
echo "1/3  Checking the token..."
$WR whoami

echo
echo "2/3  Checking the live database has every migration this code needs..."
LIST="$($WR d1 migrations list finanzas --remote -c "$PROD")"
PENDING="$(printf '%s\n' "$LIST" | { grep -Eo '[0-9]{4}_[a-z0-9_]+\.sql' || true; } | sort -u | tr '\n' ' ' | sed 's/ $//')"
if [ -n "$PENDING" ]; then
  echo "     The live database does not have: $PENDING" >&2
  echo "     Nothing was published. Run  bash scripts/deploy-wave2.sh  instead: it saves a bookmark, applies them," >&2
  echo "     then publishes." >&2
  exit 1
fi
echo "     all applied"

echo
echo "3/3  Publishing the app..."
$WR deploy -c "$PROD"

echo
echo "Done. On the iPhone, close the Finanzas app fully and open it again (twice if the old look still shows)."
echo "Tell Claude \"deployed\" so it can run the live checks."
