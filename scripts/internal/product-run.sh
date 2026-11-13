#!/usr/bin/env bash
# On-demand full product run (#5518): every automated product check against a
# fresh, isolated test instance, with a live progress page and a screenshot per step.
#
# Usage: scripts/internal/product-run.sh [options] [-- extra pytest args]
#   --config FILE   setup input (default: <repo>/product-run.local.json if present;
#                   template: product-run.local.json.example). Missing inputs are
#                   reported as "not tested".
#   --build         (re)build the test app first (scripts/internal/build-system-test-app.sh
#                   --debug). Without it the run builds only when no test app exists.
#   --no-open       do not open the progress page in the browser
#   --unattended    nobody is watching: human steps become "not tested" at once
#   --keep-serving  keep serving the progress page after the run until Ctrl-C
#
# Triggered by hand only: never scheduled, never part of per-PR or nightly CI
# (tests marked product_run are deselected without --product-run).
#
# Output: tests/system/artifacts/product-run/<run id>/ with index.html (the page),
# status.json, results.json, shots/<step>.png and shots/manifest.json.
#
# Isolation: the app gets the harness's temporary TERMIHUB_CONFIG_DIR/LOG_DIR, a
# scratch HOME/XDG_*/ZDOTDIR/HISTFILE under the run dir, and its own OS keychain
# namespace (TERMIHUB_DEV_NAME=product-run-<run id>, service
# "termiHub-dev-product-run-<run id>"). Those keychain items are removed at the end.
# The installed termiHub app, its keychain items, ~/.ssh, history and dotfiles are
# never touched; the test window is found by its process id, never by app name.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CONFIG=""
BUILD=0
OPEN=1
UNATTENDED=0
KEEP_SERVING=0
PYTEST_ARGS=()

usage() { awk 'NR==1{next} /^#/{sub(/^# ?/,""); print; next} {exit}' "${BASH_SOURCE[0]}"; }

while [ "$#" -gt 0 ]; do
    case "$1" in
    --config)
        [ "$#" -ge 2 ] || { echo "--config needs a file" >&2; exit 2; }
        CONFIG="$2"
        shift
        ;;
    --build) BUILD=1 ;;
    --no-open) OPEN=0 ;;
    --unattended) UNATTENDED=1 ;;
    --keep-serving) KEEP_SERVING=1 ;;
    -h | --help) usage; exit 0 ;;
    --) shift; PYTEST_ARGS=("$@"); break ;;
    *) echo "unknown argument: $1 (see --help)" >&2; exit 2 ;;
    esac
    shift
done

cd "$REPO"
[ -f dev.local.json ] || {
    echo "no dev.local.json in $REPO - aborting (the test ports would collide with dev0)" >&2
    exit 1
}
if [ -z "$CONFIG" ] && [ -f product-run.local.json ]; then CONFIG="$REPO/product-run.local.json"; fi
if [ -n "$CONFIG" ]; then
    [ -f "$CONFIG" ] || { echo "setup input not found: $CONFIG" >&2; exit 2; }
    CONFIG="$(cd "$(dirname "$CONFIG")" && pwd)/$(basename "$CONFIG")"
fi

case "$(uname -s)" in
Darwin) APP_SUFFIX="bundle/macos/termiHub.app/Contents/MacOS/termiHub" ;;
MINGW* | MSYS* | CYGWIN*) APP_SUFFIX="termihub.exe" ;;
*) APP_SUFFIX="termihub" ;;
esac
have_app() {
    [ -n "${TERMIHUB_TEST_APP_BINARY:-}" ] && [ -x "$TERMIHUB_TEST_APP_BINARY" ] && return 0
    [ -x "target/release/$APP_SUFFIX" ] || [ -x "target/debug/$APP_SUFFIX" ]
}
if [ "$BUILD" -eq 1 ] || ! have_app; then
    echo "building the test app (debug, with the test bridge)..."
    TERMIHUB_SKIP_RDP_HELPER="${TERMIHUB_SKIP_RDP_HELPER:-1}" \
        ./scripts/internal/build-system-test-app.sh --debug
fi

# The agent phase deploys this machine's dev agent through the app's setup wizard.
case "$(uname -s)" in
Darwin | Linux)
    if [ ! -x target/debug/termihub-agent ] && [ ! -x target/release/termihub-agent ]; then
        echo "building the dev agent (cargo build -p termihub-agent)..."
        cargo build -p termihub-agent ||
            echo "agent build failed: the agent phase will be not tested" >&2
    fi
    ;;
esac

RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)"
RUN_DIR="$REPO/tests/system/artifacts/product-run/$RUN_ID"
DEV_NAME="product-run-$RUN_ID"
mkdir -p "$RUN_DIR"

SERVER_PID=""
stop_server() {
    if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
        kill "$SERVER_PID" 2>/dev/null || true
        wait "$SERVER_PID" 2>/dev/null || true
    fi
    SERVER_PID=""
}
trap stop_server EXIT

# --- progress page server (loopback only) ---------------------------------------
(cd tests/system && exec uv run --frozen python -m termihub_harness.product_run.server \
    --run-dir "$RUN_DIR") > "$RUN_DIR/server.log" 2>&1 &
SERVER_PID=$!
URL=""
for _ in $(seq 1 100); do
    if [ -s "$RUN_DIR/server.url" ]; then URL="$(head -1 "$RUN_DIR/server.url")"; break; fi
    kill -0 "$SERVER_PID" 2>/dev/null || break
    sleep 0.2
done
if [ -n "$URL" ]; then
    echo "progress page: $URL"
else
    echo "the page server did not start (see $RUN_DIR/server.log); the page still works" \
        "as a file: $RUN_DIR/index.html" >&2
    URL="file://$RUN_DIR/index.html"
fi
if [ "$OPEN" -eq 1 ]; then
    case "$(uname -s)" in
    Darwin) open "$URL" || true ;;
    Linux) xdg-open "$URL" > /dev/null 2>&1 || true ;;
    esac
fi

# --- the run --------------------------------------------------------------------
export TERMIHUB_PRODUCT_RUN_DIR="$RUN_DIR"
export TERMIHUB_PRODUCT_RUN_DEV_NAME="$DEV_NAME"
export TERMIHUB_PRODUCT_RUN_CONFIG="$CONFIG"
export TERMIHUB_PRODUCT_RUN_UNATTENDED="$UNATTENDED"
set +e
./tests/system/pytest.sh --product-run -m product_run -p no:cacheprovider -v -rA \
    ${PYTEST_ARGS[@]+"${PYTEST_ARGS[@]}"}
RC=$?
set -e

# pytest finishes the record itself; if it died first, mark the run aborted.
if [ ! -f "$RUN_DIR/results.json" ] && [ -f "$RUN_DIR/status.json" ]; then
    (cd tests/system && uv run --frozen python -c \
        'import sys; from pathlib import Path; from termihub_harness.product_run import Recorder
Recorder(Path(sys.argv[1])).finish(state="aborted", exit_status=int(sys.argv[2]))' \
        "$RUN_DIR" "$RC") || true
fi

# --- remove this run's own keychain items (never any other service) ---------------
if [ "$(uname -s)" = "Darwin" ]; then
    case "$DEV_NAME" in
    product-run-[0-9]*) ;;
    *) echo "refusing keychain cleanup for odd namespace $DEV_NAME" >&2; DEV_NAME="" ;;
    esac
    if [ -n "$DEV_NAME" ]; then
        for base in termiHub termiHub-backup-restore termiHub-biometric-unlock \
            termiHub-biometric-unlock-v2; do
            svc="$base-dev-$DEV_NAME"
            n=0
            while [ "$n" -lt 100 ] && security delete-generic-password -s "$svc" > /dev/null 2>&1; do
                n=$((n + 1))
            done
            [ "$n" -eq 0 ] || echo "removed $n keychain item(s) of $svc"
        done
    fi
fi

# --- summary ----------------------------------------------------------------------
if [ -f "$RUN_DIR/results.json" ]; then
    python3 - "$RUN_DIR/results.json" << 'PYEOF'
import json, sys
doc = json.load(open(sys.argv[1], encoding="utf-8"))
counts = ", ".join(f"{n} {k}" for k, n in doc["summary"].items() if n)
print(f"\nproduct run {doc['run_id']}: {doc['state']} ({counts})")
for step in doc["steps"]:
    if step["status"] != "pass":
        print(f"  {step['status']:<10} {step['id']}: {step.get('reason') or ''}")
PYEOF
fi
echo "results: $RUN_DIR/results.json"
echo "screenshots: $RUN_DIR/shots/ (manifest.json for the UI review)"
echo "page: $URL"

if [ "$KEEP_SERVING" -eq 1 ] && [ -n "$SERVER_PID" ]; then
    echo "serving the page until Ctrl-C"
    wait "$SERVER_PID" || true
fi
stop_server
exit "$RC"
