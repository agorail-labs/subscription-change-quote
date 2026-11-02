#!/usr/bin/env bash
# First-time, interactive, experimental-only npm release for Agorail MSE + SCQ.
# Run inside an authenticated maintainer-owned GitHub Codespace/terminal.
# NO stored tokens, no CI-published login links, no production billing traffic.
set -euo pipefail
umask 077

SCQ_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if (( NODE_MAJOR < 22 )); then
  echo >&2 "ERROR: Node >=22 required for this release procedure."
  exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf -- "$TMP"' EXIT
mkdir -p "$TMP"/{mse,artifacts,registry}

# Require the intended account. The maintainer completes any browser or OTP
# challenges on their own machine; never place credentials in the repository.
if ! WHOAMI="$(npm whoami --registry=https://registry.npmjs.org/ 2>/dev/null)"; then
  echo "npm authentication required. Complete the web login / 2FA in your own browser."
  npm login --auth-type=web --registry=https://registry.npmjs.org/
  WHOAMI="$(npm whoami --registry=https://registry.npmjs.org/)"
fi
if [[ "$WHOAMI" != "agorail" ]]; then
  echo >&2 "ERROR: expected npm account agorail, received $WHOAMI. Nothing published."
  exit 1
fi

echo "Preparing pinned MSE source..."
git clone -q https://github.com/agorail-labs/mutation-safety-envelope.git "$TMP/mse"
git -C "$TMP/mse" checkout -q 7703f27b4fd1477d8ee614d11b6507f3c37650ee
(
  cd "$TMP/mse"
  npm ci
  npm test
  npm run build
  npm run validate-schema
  cd package
  npm run smoke:pack
  npm pack --json --pack-destination "$TMP/artifacts" > "$TMP/mse-pack.json"
)

echo "Preparing SCQ source..."
(
  cd "$SCQ_ROOT/reference"
  npm ci
  npm test
  npm run smoke:pack
  npm pack --json --pack-destination "$TMP/artifacts" > "$TMP/scq-pack.json"
)

MSE_TGZ="$TMP/artifacts/agorail-labs-mse-reference-0.4.0-experimental.1.tgz"
SCQ_TGZ="$TMP/artifacts/agorail-labs-scq-reference-0.6.2-experimental.1.tgz"
for file in "$MSE_TGZ" "$SCQ_TGZ"; do
  if [[ ! -f "$file" ]]; then echo >&2 "ERROR: audited tarball absent: $file"; exit 1; fi
done

# These exact byte digests passed independent Node20/22 external installation
# tests. Refuse to publish if the environment, contents, or build drift.
printf 'edcef7c9b43eb3a63ddd27154c34535975d6458674ea31c610bcd1553d1925a9  %s\n' "$MSE_TGZ" > "$TMP/checksums"
printf '9d2974411b536975f7121b1222e6dfc6fb6e3b84354196c2e27d6b96de127f45  %s\n' "$SCQ_TGZ" >> "$TMP/checksums"
sha256sum -c "$TMP/checksums"

publish_or_verify() {
  local spec="$1" tarball="$2" expected="$3"
  local remote
  if npm view "$spec" version --json --registry=https://registry.npmjs.org/ > /dev/null 2>&1; then
    echo "Already published: $spec. Checking registry bytes instead of overwriting."
  else
    echo "Publishing exact preflighted tarball: $spec (tag experimental; public scope)"
    npm publish "$tarball" --access public --tag experimental --registry=https://registry.npmjs.org/
  fi

  # Download the actual npm registry tarball, not just metadata.
  remote="$(npm pack "$spec" --pack-destination "$TMP/registry" --silent --registry=https://registry.npmjs.org/)"
  if [[ -z "$remote" || ! -f "$TMP/registry/$remote" ]]; then
    echo >&2 "ERROR: Registry did not return an installable tarball for $spec"; exit 1
  fi
  local got
  got="$(sha256sum "$TMP/registry/$remote" | cut -d' ' -f1)"
  if [[ "$got" != "$expected" ]]; then
    echo >&2 "ERROR: Registry artifact differs from audited tarball for $spec"
    echo >&2 "Expected $expected; received $got"
    exit 1
  fi
  if ! npm dist-tag ls "${spec%@*}" --registry=https://registry.npmjs.org/ | grep -Fx "experimental: ${spec##*@}"; then
    echo >&2 "ERROR: Missing correct experimental registry dist-tag on $spec"
    exit 1
  fi
  echo "VERIFIED registry package, exact bytes and experimental dist-tag: $spec"
}

publish_or_verify '@agorail-labs/mse-reference@0.4.0-experimental.1' "$MSE_TGZ" 'edcef7c9b43eb3a63ddd27154c34535975d6458674ea31c610bcd1553d1925a9'
publish_or_verify '@agorail-labs/scq-reference@0.6.2-experimental.1' "$SCQ_TGZ" '9d2974411b536975f7121b1222e6dfc6fb6e3b84354196c2e27d6b96de127f45'

echo "SUCCESS: BOTH audited experimental packages are published and verified."
