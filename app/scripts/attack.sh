#!/usr/bin/env bash
# Seguridad's attack run against a THROWAWAY local server and database. Never the seeded one.
#
#   scripts/attack.sh            # port 8791, state in app/.wrangler/attack-state (deleted after)
#   scripts/attack.sh --keep     # keep the throwaway database and server log for a look afterwards
#
# What it does: makes two users (alice, the owner, and bob), saves script and formula payloads as
# shop, note, tag, group, category and account names, then tries cross-user reads and writes,
# requests from another site, oversized bodies, bad dates, lockout abuse and the owner tools
# (scripts/attack.py, API part). Then alice imports a made-up bank CSV, a made-up PDF statement and
# the same PDF locked with a password through the import screen, with payloads inside the files, plus
# files too big to read; bob tries her imports, undo, column map and fixed payments (import part).
# Then it opens every screen, sheet and chart tooltip in headless Chrome as both users, plus hostile
# address-bar values, to confirm no payload runs and nothing of alice's shows for bob (browser part).
# Prints PASS or FAIL per check, never a passphrase or cookie. Exit code 0 only when all pass.
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${FZ_ATTACK_PORT:-8791}"
PY="${FZ_ATTACK_PYTHON:-$HOME/.venvs/finanzas-tests/bin/python}"
STATE="$PWD/.wrangler/attack-state"
KEEP=0
[[ "${1:-}" == "--keep" ]] && KEEP=1

case "$PORT" in
  8788|8790) echo "refusing port $PORT: that is the main or the design server" >&2; exit 2 ;;
esac
if ss -ltn "( sport = :$PORT )" | grep -q LISTEN; then
  echo "port $PORT is busy; stop that server first" >&2
  exit 2
fi
[[ -x "$PY" ]] || { echo "needs the Playwright venv at $PY" >&2; exit 2; }

# shellcheck disable=SC1091
source "$HOME/.nvm/nvm.sh" >/dev/null
nvm use >/dev/null

umask 077
rm -rf "$STATE"
mkdir -p "$STATE"

SERVER_PID=""
cleanup() {
  if [[ -n "$SERVER_PID" ]]; then
    kill -- "-$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  if [[ "$KEEP" == 0 ]]; then rm -rf "$STATE"; else echo "kept $STATE"; fi
}
trap cleanup EXIT

echo "== throwaway database in $STATE"
npx wrangler d1 migrations apply finanzas --local --persist-to "$STATE" >/dev/null
# alice is created first, so she is the owner. Her display name carries payloads too.
node scripts/add-user.ts alice "Alice <img src=x onerror=alert(1)> \$& \$' =1+1" "$STATE/user-alice-local.sql" \
  --local-login "$STATE/alice-login.txt" >/dev/null
node scripts/add-user.ts bob "Bob" "$STATE/user-bob-local.sql" --local-login "$STATE/bob-login.txt" >/dev/null
for u in alice bob; do
  npx wrangler d1 execute finanzas --local --persist-to "$STATE" --file "$STATE/user-$u-local.sql" >/dev/null
done

echo "== throwaway server on http://127.0.0.1:$PORT"
# Face ID: the browser checks run at http://localhost:$PORT (a passkey cannot use an IP address), so the
# server expects that origin and RP ID, and invite links point there.
setsid npx wrangler dev --local --ip 127.0.0.1 --port "$PORT" --inspector-port "$((PORT + 1000))" \
  --var "APP_ORIGIN:http://localhost:$PORT" --var "RP_ID:localhost" \
  --persist-to "$STATE" >"$STATE/server.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 90); do
  curl -fsS -o /dev/null "http://127.0.0.1:$PORT/" 2>/dev/null && break
  sleep 1
done
curl -fsS -o /dev/null "http://127.0.0.1:$PORT/" || { echo "server did not start; see $STATE/server.log" >&2; KEEP=1; exit 2; }

set +e
"$PY" -I -B scripts/attack.py "http://127.0.0.1:$PORT" "$STATE"
RC=$?
set -e
exit "$RC"
