#!/usr/bin/env bash
#
# Fail if a shipped agent binary still contains env-var-armed test scaffolding.
#
# The agent's test hooks are compiled only into debug builds and builds made
# with the `test-hooks` cargo feature (the system-test agent). A default
# `cargo build --release` agent must contain neither the hooks nor the env-var
# names that arm them, so nothing in a user's environment can trigger them:
#   - TERMIHUB_TEST_PARENT_PID: the parent-death watchdog that hard-exits the
#     agent when a PID disappears (#3641, WA-RS2-003)
#   - TERMIHUB_TEST_STARTUP_DELAY_MS: the #1579 listener startup delay (WA-RS-009)
#   - TERMIHUB_AGENT_TEST_PENDING_UPDATE: the self-update test hook (AGT-008)
# The names are read from their Rust definitions, so the guard cannot drift
# from the code. A name appearing in a binary means the hook was compiled in.
#
# Usage:
#   scripts/internal/assert-no-agent-test-hooks.sh <binary>...
#
# Exit status: 0 = clean, 1 = a test-hook name found, 2 = usage / missing file.
# Runs in agent.yml on every agent build and in release.yml before the release
# agents are signed. check-script-headless.sh runs it against dummy binaries.

set -euo pipefail

# Byte-wise matching: the binaries are not valid UTF-8 and the names are plain
# ASCII. The C locale keeps grep from tripping over encoding errors.
export LC_ALL=C

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
    sed -n '2,21p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
AGENT_SRC="$REPO_ROOT/agent/src"

if [ "$#" -eq 0 ]; then
    echo "usage: $0 <binary>..." >&2
    exit 2
fi

# <file> <sed expression printing the name>: append the name to `names`, or
# fail with exit 2 when the definition has moved (the guard must not go blind).
names=()
add_name() {
    local name
    name="$(sed -n "$2" "$AGENT_SRC/$1" | head -n 1)"
    if [ -z "$name" ]; then
        echo "assert-no-agent-test-hooks: test-hook env name not found in agent/src/$1" >&2
        exit 2
    fi
    names+=("$name")
}
add_name test_parent_watchdog.rs 's/^pub const PARENT_PID_ENV: &str = "\(.*\)";$/\1/p'
add_name io/tcp.rs 's/^ *if let Some(ms) = std::env::var("\(TERMIHUB_TEST_[A-Z_]*\)")$/\1/p'
add_name update/test_hook.rs 's/^pub const TEST_PENDING_UPDATE_ENV: &str = "\(.*\)";$/\1/p'

found=0
for bin in "$@"; do
    if [ ! -f "$bin" ]; then
        echo "assert-no-agent-test-hooks: no such file: $bin" >&2
        exit 2
    fi
    hit=0
    for name in "${names[@]}"; do
        if grep -qaF -- "$name" "$bin"; then
            echo "::error::$bin contains the test-hook env var $name: it was built" \
                "with debug assertions or the test-hooks feature and must never ship" >&2
            hit=1
        fi
    done
    if [ "$hit" -eq 1 ]; then
        found=1
    else
        echo "ok: $bin contains no env-armed agent test hooks"
    fi
done

exit "$found"
