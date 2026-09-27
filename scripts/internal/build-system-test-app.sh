#!/usr/bin/env bash
# Build the desktop app the Python bridge system-test harness drives.
#
# This is the ONE place the system-test app's build recipe lives. The nightly
# system-integration workflow and scripts/test-system-py.sh both call it, so the
# recipe travels with the code being graded instead of being copied into the
# workflow file. That copy drifted: the scheduled nightly runs the workflow file
# on the DEFAULT branch (main) but builds develop, and main's copy still used
# the pre-SEC-005 command. It built a develop app without the test bridge, so
# every suite failed with "no app connected to the bridge" for two weeks (#3664).
#
# Usage: scripts/internal/build-system-test-app.sh [--debug | --release]
#   --debug     Debug profile (target/debug; faster build). What CI uses.
#   --release   Release profile (target/release). The default.
#
# What the recipe needs, and why:
#   --features test-bridge + VITE_TEST_BRIDGE=1 (SEC-005): the WebSocket test
#       bridge and its runtime CSP relaxation are compiled out of normal builds.
#       The frontend also ignores the bridge activation signals unless it was
#       built with VITE_TEST_BRIDGE=1. The harness needs BOTH, or the app boots
#       fine and never dials the bridge. There is no --config CSP overlay
#       (#3628): the bridge adds its loopback ws:// connect-src at startup.
#   --features mock-remote-desktop (DEAD-001): the mock graphical backend left
#       the crate's default features. The integration lane uses it to test the
#       remote-desktop layer without a real VNC/RDP server.
set -euo pipefail

PROFILE_FLAGS=()

while [ "$#" -gt 0 ]; do
    case "$1" in
    --debug) PROFILE_FLAGS=(--debug) ;;
    --release) PROFILE_FLAGS=() ;;
    --help | -h)
        # Print the contiguous comment header (skip the shebang, stop at the
        # first non-comment line) with the leading "# " stripped.
        awk 'NR==1{next} /^#/{sub(/^# ?/,""); print; next} {exit}' "$0"
        exit 0
        ;;
    *)
        echo "Unknown argument: $1 (see --help)" >&2
        exit 1
        ;;
    esac
    shift
done

cd "$(git rev-parse --show-toplevel)"

set -x
VITE_TEST_BRIDGE=1 pnpm tauri build ${PROFILE_FLAGS[@]+"${PROFILE_FLAGS[@]}"} \
    --features "mock-remote-desktop test-bridge"
