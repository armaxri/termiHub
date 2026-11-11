#!/usr/bin/env bash
#
# Fail if a desktop app binary was built with the `test-bridge` cargo feature.
#
# The test bridge (SEC-005) is test scaffolding: a scriptable WebSocket bridge, a
# relaxed CSP, and test-only commands such as test_allow_dialog_path (the fs
# grant for stubbed native dialogs, #4122) and test_exit_app. All of it is
# compiled in only with `--features test-bridge`, and so is the byte marker
# TEST_BRIDGE_BUILD_MARKER (src-tauri/src/utils/test_bridge.rs), which the bridge
# logs when it activates and which therefore stays in the binary's read-only
# data. The marker appearing in a binary means the build enabled test-bridge,
# and that binary must never ship. The guard also fails a binary that carries
# the name of the TERMIHUB_TEST_HTTP_BASE env var (TEST_HTTP_BASE_ENV in the
# same file, #5388), the seam that sends update and plugin-index fetches to a
# local fixture server: a release build must not read it.
#
# Usage:
#   scripts/internal/assert-no-test-bridge.sh <binary>...
#
# Exit status: 0 = clean, 1 = marker found, 2 = usage / missing file.
# Runs in release.yml on every desktop release build, before the installer is
# uploaded. check-script-headless.sh runs it against dummy binaries per PR.

set -euo pipefail

# Byte-wise matching: the binaries are not valid UTF-8 and the marker is plain
# ASCII. The C locale keeps grep from tripping over encoding errors.
export LC_ALL=C

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
    sed -n '2,23p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
MARKER_SOURCE="$REPO_ROOT/src-tauri/src/utils/test_bridge.rs"

if [ "$#" -eq 0 ]; then
    echo "usage: $0 <binary>..." >&2
    exit 2
fi

# Read the marker from its one definition, so the two can never drift.
marker="$(sed -n 's/^pub const TEST_BRIDGE_BUILD_MARKER: &str = "\(.*\)";$/\1/p' "$MARKER_SOURCE")"
if [ -z "$marker" ]; then
    echo "assert-no-test-bridge: TEST_BRIDGE_BUILD_MARKER not found in $MARKER_SOURCE" >&2
    exit 2
fi

# The test-only env names whose read a release binary must not carry.
http_base_env="$(sed -n 's/^pub const TEST_HTTP_BASE_ENV: &str = "\(.*\)";$/\1/p' "$MARKER_SOURCE")"
if [ -z "$http_base_env" ]; then
    echo "assert-no-test-bridge: TEST_HTTP_BASE_ENV not found in $MARKER_SOURCE" >&2
    exit 2
fi

found=0
for bin in "$@"; do
    if [ ! -f "$bin" ]; then
        echo "assert-no-test-bridge: no such file: $bin" >&2
        exit 2
    fi
    if grep -qaF -- "$marker" "$bin"; then
        echo "::error::$bin was built with the test-bridge feature (it carries" \
            "TEST_BRIDGE_BUILD_MARKER) and must never ship (SEC-005)" >&2
        found=1
    elif grep -qaF -- "$http_base_env" "$bin"; then
        echo "::error::$bin reads the test-only env var $http_base_env (#5388)" \
            "and must never ship" >&2
        found=1
    else
        echo "ok: $bin carries no test-bridge code"
    fi
done

exit "$found"
