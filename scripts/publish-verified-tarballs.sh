#!/usr/bin/env bash
# Publish only the exact CI-attested experimental Agorail MSE/SCQ tarballs.
# Usage: bash scripts/publish-verified-tarballs.sh /path/to/downloaded-GitHub-Actions-artifact
# Never recompiles or silently substitutes a local npm pack.
set -euo pipefail
umask 077

if [[ $# -ne 1 || ! -d "$1" ]]; then
  echo >&2 "Usage: bash scripts/publish-verified-tarballs.sh /path/to/unpacked-CI-artifact"
  exit 2
fi
SRC="$(cd -- "$1" && pwd)"
MSE="$SRC/agorail-labs-mse-reference-0.4.0-experimental.1.tgz"
SCQ="$SRC/agorail-labs-scq-reference-0.6.2-experimental.1.tgz"
MSE_HASH="edcef7c9b43eb3a63ddd27154c34535975d6458674ea31c610bcd1553d1925a9"
SCQ_HASH="9d2974411b536975f7121b1222e6dfc6fb6e3b84354196c2e27d6b96de127f45"
REGISTRY="https://registry.npmjs.org/"
TMP="$(mktemp -d)"
trap 'rm -rf -- "$TMP"' EXIT

# Verify both files and contents BEFORE opening any npm login challenge.
for file in "$MSE" "$SCQ"; do
  if [[ ! -f "$file" ]]; then echo >&2 "Missing CI artifact: $file"; exit 1; fi
  tar -tzf "$file" > "$TMP/entries"
  if grep -E '(^package/dist/src/live/|^package/dist/src/integration/|^package/scripts/|(^|/)\.npmrc$|(^|/)\.env$)' "$TMP/entries"; then
    echo >&2 "Refusing to publish disallowed files in $file"; exit 1
  fi
done
printf '%s  %s\n' "$MSE_HASH" "$MSE" "$SCQ_HASH" "$SCQ" > "$TMP/expected.sha256"
sha256sum -c "$TMP/expected.sha256"

npm whoami --registry="$REGISTRY" > "$TMP/whoami" 2>/dev/null || {
  echo "Complete npm browser login and 2FA under the repository owner's account."
  npm login --auth-type=web --registry="$REGISTRY"
  npm whoami --registry="$REGISTRY" > "$TMP/whoami"
}
if [[ "$(cat "$TMP/whoami")" != "agorail" ]]; then
  echo >&2 "Wrong npm account. Expected agorail. No packages published."
  exit 1
fi

publish_one() {
  local spec="$1" file="$2" expected="$3"
  local package="${spec%@*}" ver="${spec##*@}"
  if npm view "$spec" version --registry="$REGISTRY" > /dev/null 2>&1; then
    echo "Existing registry version found: $spec; verifying instead of replacing."
  else
    echo "Publishing $spec with experimental dist-tag."
    npm publish "$file" --access public --tag experimental --registry="$REGISTRY"
  fi
  mkdir -p "$TMP/registry"
  local actual
  actual="$(npm pack "$spec" --pack-destination "$TMP/registry" --silent --registry="$REGISTRY")"
  [[ -f "$TMP/registry/$actual" ]] || { echo >&2 "Registry download missing: $spec"; exit 1; }
  printf '%s  %s\n' "$expected" "$TMP/registry/$actual" | sha256sum -c -
  if ! npm dist-tag ls "$package" --registry="$REGISTRY" | grep -Fx "experimental: $ver"; then
    echo >&2 "Registry has no expected experimental tag for $spec"
    exit 1
  fi
  echo "VERIFIED registry tarball and experimental tag: $spec"
}
publish_one '@agorail-labs/mse-reference@0.4.0-experimental.1' "$MSE" "$MSE_HASH"
publish_one '@agorail-labs/scq-reference@0.6.2-experimental.1' "$SCQ" "$SCQ_HASH"
echo "BOTH PUBLISHED AND VERIFIED: immutable CI-attested experimental packages."
