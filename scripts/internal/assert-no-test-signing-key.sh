#!/usr/bin/env bash
#
# Fail if a shipped agent binary embeds the TEST-ONLY update-signing key (#4083).
#
# Only agents built with the `test-hooks` cargo feature (the system-test build)
# may trust agent/keys/test-only/update-signing-TEST-ONLY.pub.pem. The key is
# compiled in verbatim (include_str!) under #[cfg(feature = "test-hooks")], so
# its base64 line appearing in a binary means the build enabled test-hooks.
# That binary must never ship: anyone can sign an update with the committed
# private half.
#
# Usage:
#   scripts/internal/assert-no-test-signing-key.sh <binary>...
#
# Also fails if the release trust file (agent/keys/update-signing.pub.pem)
# lists the test key. Exit status: 0 = clean, 1 = test key found, 2 = usage.
# Runs in agent.yml (every agent build, including the per-PR Linux builds) and
# in release.yml (every release asset, before it is signed).

set -euo pipefail

# Byte-wise matching: the binaries are not valid UTF-8, and the needle is plain
# ASCII base64. The C locale keeps grep from tripping over encoding errors (and
# makes it faster), identically on Linux, macOS and Windows Git Bash.
export LC_ALL=C

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TEST_PUB="$REPO_ROOT/agent/keys/test-only/update-signing-TEST-ONLY.pub.pem"
RELEASE_PUB="$REPO_ROOT/agent/keys/update-signing.pub.pem"

if [ "$#" -eq 0 ]; then
    echo "usage: $0 <binary>..." >&2
    exit 2
fi

# The base64 body line(s) of the PEM block — exactly what include_str! embeds.
needles=()
while IFS= read -r line; do
    needles+=("$line")
done < <(sed -n '/-----BEGIN PUBLIC KEY-----/,/-----END PUBLIC KEY-----/p' "$TEST_PUB" |
    grep -v -- '-----' | tr -d '\r')
if [ "${#needles[@]}" -eq 0 ]; then
    echo "assert-no-test-signing-key: no key found in $TEST_PUB" >&2
    exit 2
fi

found=0
for needle in "${needles[@]}"; do
    if grep -qF -- "$needle" "$RELEASE_PUB"; then
        echo "::error::$RELEASE_PUB trusts the TEST-ONLY update-signing key — remove it" >&2
        found=1
    fi
done

for bin in "$@"; do
    if [ ! -f "$bin" ]; then
        echo "assert-no-test-signing-key: no such file: $bin" >&2
        exit 2
    fi
    hit=0
    for needle in "${needles[@]}"; do
        if grep -qaF -- "$needle" "$bin"; then
            hit=1
        fi
    done
    if [ "$hit" -eq 1 ]; then
        echo "::error::$bin embeds the TEST-ONLY update-signing key: it was built with the" \
            "test-hooks feature and must never ship (see agent/keys/test-only/README.md)" >&2
        found=1
    else
        echo "ok: $bin does not embed the TEST-ONLY update-signing key"
    fi
done

exit "$found"
