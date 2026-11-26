#!/usr/bin/env bash
# Privacy check for the Finanzas repo (owned by Seguridad).
#
# Fails if git holds, or a plain `git add -A` would add, private data: the data/ folder, reports,
# database dumps, bank files, env and secrets files, real card or account endings, people's names,
# real email addresses, payment handles, passphrases or other secrets. It scans every file git
# tracks or would add (the working copy and the staged copy) and, once there are commits, every path
# and file ever committed. It prints file names, line numbers and rule names only, never the text.
#
# Usage: app/scripts/git-privacy-check.sh [-q]    (-q: do not list the files)
# Exit: 0 clean, 1 private data found, 2 cannot run the check.
#
# Names and card endings are private, so they are not in this script: they are read from
# data/privacy_terms.txt (ignored by git), one extended regex per line. It is looked up in
# $FINANZAS_PRIVACY_TERMS, this checkout's data/, the main checkout's data/ (for git worktrees),
# then ~/finanzas/data/. Real passphrases are read from data/*login*.txt the same way, only to
# compare, and never printed.
set -uo pipefail

quiet=0
[[ "${1:-}" == "-q" ]] && quiet=1

root=$(git -C "$(dirname "$0")" rev-parse --show-toplevel 2>/dev/null) || { echo "privacy check: not inside a git repo" >&2; exit 2; }
cd "$root" || exit 2
main=$(cd "$(git rev-parse --git-common-dir)/.." && pwd)  # the main checkout, also when run from a worktree

problems=0
fail() { echo "FAIL $*"; problems=$((problems + 1)); }

# ---- private terms (names, card and account endings) ----
terms_file=""
for f in "${FINANZAS_PRIVACY_TERMS:-}" "$root/data/privacy_terms.txt" "$main/data/privacy_terms.txt" "$HOME/finanzas/data/privacy_terms.txt"; do
  if [[ -n "$f" && -r "$f" ]]; then terms_file=$f; break; fi
done
if [[ -z "$terms_file" ]]; then
  echo "privacy check: data/privacy_terms.txt not found, so names and card endings cannot be checked" >&2
  exit 2
fi
TERMS=(); TERM_LINE=()
while IFS= read -r x; do
  TERM_LINE+=("${x%%:*}"); TERMS+=("${x#*:}")
done < <(grep -n -v -E '^[[:space:]]*(#|$)' "$terms_file")
if (( ${#TERMS[@]} == 0 )); then echo "privacy check: $terms_file has no terms" >&2; exit 2; fi
grep -q -E -f <(printf '%s\n' "${TERMS[@]}") /dev/null 2>/dev/null
if (( $? == 2 )); then echo "privacy check: a pattern in $terms_file is not a valid regex" >&2; exit 2; fi
data_dir=$(dirname "$terms_file")

# ---- real secrets to look for (kept in memory only) ----
SECRETS=()
for f in "$data_dir"/*login*.txt "$data_dir"/.*login*.txt; do
  [[ -r "$f" ]] || continue
  while IFS= read -r s; do SECRETS+=("$s"); done < <(grep -o -i -E '[a-z2-9]{5}(-[a-z2-9]{5}){4}' "$f" 2>/dev/null)
done
gmail_env="$HOME/.config/finanzas/gmail.env"  # the Gmail app password tools/fetch_gmail.py reads
if [[ -r "$gmail_env" ]]; then
  s=$(sed -n 's/^SMTP_PASSWORD=//p' "$gmail_env" | head -1 | tr -d "\"'\r")
  if (( ${#s} >= 8 )); then SECRETS+=("$s" "${s// /}"); fi
  unset s
fi

# Placeholder values that look like secrets on purpose (test login, doc example).
EXAMPLES=(-e "abcde-fghjk-mnpqr-stuvw-xyz23" -e "k7mqx-2hd9w-pzr4c-u8vbn-e3tfa")
ALLOWED_EMAIL='@(example\.(com|org|net)|[a-z0-9.-]+\.(test|invalid|example|localhost)|baccredomatic\.com|bancoagricola\.com)$'
EMAIL='[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}'
RX_PHRASE='(^|[^A-Za-z0-9-])[a-z2-9]{5}(-[a-z2-9]{5}){4}([^A-Za-z0-9-]|$)'
# Perl regexes (grep -P). \x22 \x27 \x60 are the three quote marks. A value only counts when it has
# no spaces and holds a digit, so labels like passphrase: "Frase de acceso" pass.
RX_KEY_CS='-----BEGIN [A-Z ]*PRIVATE KEY-----|fzk_[A-Za-z0-9_-]{20,}|(PASSWORD|PASSPHRASE|SECRET|API_TOKEN|API_KEY|PRIVATE_KEY)[A-Z_]*[\x22\x27]?\s*[=:]\s*[\x22\x27]?(?=[^\x22\x27\s$<{(]*[0-9])[^\x22\x27\s$<{(]{8,}|[\x22\x27][a-z]{4} [a-z]{4} [a-z]{4} [a-z]{4}[\x22\x27]'
RX_KEY_CI='(?i)pass(word|phrase)[\x22\x27]?\s*[:=]\s*[\x22\x27\x60](?=[^\x22\x27\x60\s]*[0-9])[^\x22\x27\x60\s]{8,}[\x22\x27\x60]'
HANDLE='(p2p|paypal|zelle|venmo|nequi|wise|transfer[a-z]*)[^@[:cntrl:]]{0,40}@[A-Za-z0-9_.]{3,}'

# Vetted outside code (SECURITY.md, "pdf.js"), minified, so it matches the name, email and secret patterns by
# chance. Only these exact paths skip the text scan, and only while the bytes are the vetted build: any other
# content at these paths fails the check. Changing this list needs Seguridad's OK.
declare -A VENDORED=(
  [app/public/vendor/pdfjs-6.5.438/pdf.min.mjs]=3a88402882cfa3e7e72c2c9b5149f52f0f88baf1c5b62aa11a41abdbc2072440
  [app/public/vendor/pdfjs-6.5.438/pdf.worker.min.mjs]=1e64c8240e54735ec5913b37acd5134747799cb8c6bb3777c70adbc01232d2aa
)
vendored_ok() {  # $1 path, $2 file holding its bytes: 0 when that path is vendored and the bytes are the vetted build
  [[ -n "${VENDORED[$1]:-}" ]] && [[ "$(sha256sum < "$2" | cut -d' ' -f1)" == "${VENDORED[$1]}" ]]
}

# Line numbers (comma list, at most 5) read from grep -n output on stdin. The text is dropped here.
lines() { cut -d: -f1 | sort -un | head -5 | paste -sd, -; }

path_problem() {  # prints why a path must never be in git, or nothing
  local p=$1 l=${1,,}
  case "$l" in
    data/*|*/data/*) echo "private data folder (data/)" ;;
    report/*) echo "generated report (report/)" ;;
    *.sql) [[ "$p" == app/migrations/*.sql ]] || echo "database file (.sql outside app/migrations)" ;;
    *.pdf) echo "PDF (statements)" ;;
    *.csv) echo "CSV (bank export)" ;;
    *.xls|*.xls?) echo "spreadsheet" ;;
    *.eml|*.ofx|*.qfx) echo "bank email or export" ;;
    .env|*/.env|.env.*|*/.env.*) echo "env file" ;;
    .dev.vars|*/.dev.vars|.dev.vars.*|*/.dev.vars.*) echo "Wrangler secrets file" ;;
    *login*.txt) echo "login file" ;;
    *__pycache__/*|*.pyc) echo "Python cache" ;;
    .ds_store|*/.ds_store) echo "macOS junk file" ;;
  esac
}

scan() {  # $1 label for messages, $2 file to read
  local label=$1 f=$2 n i
  grep -q -I . "$f" 2>/dev/null || return 0  # binary or empty: nothing to read
  if grep -q -i -E -f <(printf '%s\n' "${TERMS[@]}") "$f"; then
    for i in "${!TERMS[@]}"; do
      n=$(grep -n -i -E -e "${TERMS[$i]}" "$f" | lines)
      [[ -n "$n" ]] && fail "$label:$n private term (line ${TERM_LINE[$i]} of privacy_terms.txt)"
    done
  fi
  if (( ${#SECRETS[@]} )); then
    n=$(grep -n -F -f <(printf '%s\n' "${SECRETS[@]}") "$f" | lines)
    [[ -n "$n" ]] && fail "$label:$n a real passphrase or password"
  fi
  n=$(grep -n -o -E "$EMAIL" "$f" | grep -v -i -E "$ALLOWED_EMAIL" | lines)
  [[ -n "$n" ]] && fail "$label:$n email address (only placeholder and bank sender addresses are allowed)"
  n=$(grep -n -o -i -E "$RX_PHRASE" "$f" | grep -v -i -F "${EXAMPLES[@]}" | lines)
  [[ -n "$n" ]] && fail "$label:$n looks like a passphrase"
  n=$( { grep -n -P -e "$RX_KEY_CS" "$f"; grep -n -P -e "$RX_KEY_CI" "$f"; } | grep -v -i -F "${EXAMPLES[@]}" | lines)
  [[ -n "$n" ]] && fail "$label:$n looks like a secret (key, token or password)"
  n=$(grep -n -i -E -e "$HANDLE" "$f" | lines)
  [[ -n "$n" ]] && fail "$label:$n looks like a payment handle"
}

# ---- what git holds and what `git add -A` would add ----
WOULD_ADD=()
while IFS= read -r x; do WOULD_ADD+=("$x"); done < <(git add -A --dry-run 2>/dev/null | sed -n "s/^add '\(.*\)'\$/\1/p")
FILES=()
while IFS= read -r -d '' x; do FILES+=("$x"); done < <(git ls-files -z --cached --others --exclude-standard)

if (( ! quiet )); then
  echo "git add -A would add ${#WOULD_ADD[@]} files:"
  for p in "${WOULD_ADD[@]}"; do echo "  $p"; done
fi

for p in "${WOULD_ADD[@]}" "${FILES[@]}"; do
  r=$(path_problem "$p")
  [[ -n "$r" ]] && fail "$p: $r"
done
mapfile -t FILES < <(printf '%s\n' "${FILES[@]}" | sort -u)

tmp=$(mktemp) || exit 2
chmod 600 "$tmp"
trap 'rm -f "$tmp"' EXIT
vendored=0
for p in "${FILES[@]}"; do
  if [[ -n "${VENDORED[$p]:-}" ]]; then
    # Vetted outside code: the bytes must be the vetted build (working and staged copy), then no text scan.
    if [[ -f "$p" ]] && ! vendored_ok "$p" "$p"; then fail "$p: not the vetted build (sha256 differs)"; fi
    if git ls-files --error-unmatch -- "$p" >/dev/null 2>&1; then
      git show ":$p" > "$tmp" 2>/dev/null && { vendored_ok "$p" "$tmp" || fail "$p (staged): not the vetted build (sha256 differs)"; }
    fi
    vendored=$((vendored + 1))
    continue
  fi
  [[ -f "$p" ]] && scan "$p" "$p"
  # The staged copy is what a commit takes; check it too when it differs from the working copy.
  if git ls-files --error-unmatch -- "$p" >/dev/null 2>&1 && ! git diff --quiet -- "$p" 2>/dev/null; then
    git show ":$p" > "$tmp" 2>/dev/null && scan "$p (staged)" "$tmp"
  fi
done

# ---- history: every path and file ever committed ----
commits=0
if git rev-parse -q --verify HEAD >/dev/null; then
  REVS=($(git rev-list --all))
  commits=${#REVS[@]}
  while IFS= read -r p; do
    r=$(path_problem "$p")
    [[ -n "$r" ]] && fail "history: $p: $r"
  done < <(git log --all --format= --name-only | sort -u)
  # The vendored paths are left out of the history text scan, but every version of them ever committed must be
  # the vetted build.
  EXCLUDE=()
  for v in "${!VENDORED[@]}"; do
    EXCLUDE+=(":(exclude,literal)$v")
    while IFS= read -r blob; do
      git cat-file blob "$blob" > "$tmp" && vendored_ok "$v" "$tmp" || fail "history: $v blob ${blob:0:8}: not the vetted build"
    done < <(for r in "${REVS[@]}"; do git rev-parse -q --verify "$r:$v" 2>/dev/null; done | sort -u)
  done
  # -l prints rev:path only, never the text.
  while IFS= read -r x; do fail "history: ${x:0:8}${x:40}: private term"; done \
    < <(git grep -I -l -i -E -f <(printf '%s\n' "${TERMS[@]}") "${REVS[@]}" -- . "${EXCLUDE[@]}" 2>/dev/null | head -20)
  if (( ${#SECRETS[@]} )); then
    while IFS= read -r x; do fail "history: ${x:0:8}${x:40}: a real passphrase or password"; done \
      < <(git grep -I -l -F -f <(printf '%s\n' "${SECRETS[@]}") "${REVS[@]}" -- . "${EXCLUDE[@]}" 2>/dev/null | head -20)
  fi
fi
unset SECRETS

if (( problems )); then
  echo "privacy check FAILED: $problems problem(s). Nothing above shows the private text itself."
  exit 1
fi
echo "privacy check OK: ${#FILES[@]} files git holds or would add ($vendored vetted vendor files checked by sha256), $commits commits; no private data found (terms from $terms_file)."
