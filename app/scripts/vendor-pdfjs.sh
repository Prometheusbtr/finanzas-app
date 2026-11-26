#!/usr/bin/env bash
# The vetted pdf.js build (SECURITY.md, "pdf.js") in public/vendor/pdfjs-6.5.438/. The three files are
# committed; this script checks them and can fetch them again. The tarball's sha512 must match the registry's,
# and each copied file must match the hash below (the privacy check pins the same two .mjs hashes).
#   scripts/vendor-pdfjs.sh --check   only check the files (deploy.sh runs this); exit 1 when one is missing or differs
#   scripts/vendor-pdfjs.sh           check, and when one differs fetch the tarball again. Never installs anything.
set -euo pipefail

VERSION=6.5.438
SHA512="vg8Pw1x+AFKy4AMDvhuWl5cOYV8d698UoEANoFFhc79hqXDnZQqnOXoxw3HG907WHOg1JYOvLhP756boddFxpA=="
app=$(cd "$(dirname "$0")/.." && pwd)
dest="$app/public/vendor/pdfjs-$VERSION"

expected() {
  case "$1" in
    pdf.min.mjs) echo 3a88402882cfa3e7e72c2c9b5149f52f0f88baf1c5b62aa11a41abdbc2072440 ;;
    pdf.worker.min.mjs) echo 1e64c8240e54735ec5913b37acd5134747799cb8c6bb3777c70adbc01232d2aa ;;
    LICENSE) echo 0d542e0c8804e39aa7f37eb00da5a762149dc682d7829451287e11b938e94594 ;;
  esac
}

ok=1
for f in pdf.min.mjs pdf.worker.min.mjs LICENSE; do
  [[ -f "$dest/$f" && "$(sha256sum "$dest/$f" | cut -d' ' -f1)" == "$(expected "$f")" ]] || ok=0
done
if (( ok )); then echo "pdf.js $VERSION in place, hashes match"; exit 0; fi
if [[ "${1:-}" == "--check" ]]; then echo "pdf.js $VERSION files in public/vendor/pdfjs-$VERSION are missing or not the vetted build" >&2; exit 1; fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
( cd "$tmp" && npm pack "pdfjs-dist@$VERSION" --silent >/dev/null )
tgz="$tmp/pdfjs-dist-$VERSION.tgz"
got=$(openssl dgst -sha512 -binary "$tgz" | base64 -w0)
registry=$(npm view "pdfjs-dist@$VERSION" dist.integrity)
[[ "sha512-$got" == "sha512-$SHA512" && "$registry" == "sha512-$SHA512" ]] || { echo "pdf.js tarball hash does not match" >&2; exit 1; }
mkdir -p "$tmp/x"
tar -xzf "$tgz" -C "$tmp/x" package/build/pdf.min.mjs package/build/pdf.worker.min.mjs package/LICENSE
mkdir -p "$dest"
for f in build/pdf.min.mjs build/pdf.worker.min.mjs LICENSE; do
  b=$(basename "$f")
  [[ "$(sha256sum "$tmp/x/package/$f" | cut -d' ' -f1)" == "$(expected "$b")" ]] || { echo "$b hash does not match" >&2; exit 1; }
  install -m 644 "$tmp/x/package/$f" "$dest/$b"
done
echo "pdf.js $VERSION copied to public/vendor/pdfjs-$VERSION, hashes match"
