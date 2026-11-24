#!/usr/bin/env bash
# On-demand full product run (#5518): every automated product check against a
# fresh, isolated test instance, with a live progress page and a screenshot per step.
#
# Usage: scripts/internal/product-run.sh [options] [-- extra pytest args]
#   --config FILE   setup input (default: <repo>/product-run.local.json if present;
#                   template: product-run.local.json.example). Missing inputs are
#                   reported as "not tested".
#   --build         (re)build the test app first (scripts/internal/build-system-test-app.sh
#                   --debug), the RDP sidecar with its rdp_test_server example included
#                   (TERMIHUB_SKIP_RDP_HELPER=1 opts out). Without it the run builds only
#                   when no test app exists, and then skips the RDP sidecar.
#   --no-open       do not open the progress page in the browser
#   --unattended    nobody is watching: human steps become "not tested" at once
#   --keep-serving  keep serving the progress page after the run until Ctrl-C
#   --real-pointer  hover grades use the real OS pointer (moves your mouse; sets
#                   TERMIHUB_OS_INPUT_GLOBAL=1 for the run). Refused - and the bridge
#                   paints the hover instead - while any other termiHub (the installed
#                   app included) is running; see termihub_harness/os_input/base.py.
#
# Review loop (#5817): after a run's UI review was merged (review/grades.json),
#   --loop S[,S...]  re-run only the tests behind those surfaces into a new run dir
#                    linked to the previous one (review/previous-run, loop.json); its
#                    review request carries the previous grade and findings. Surfaces
#                    already at the target drop out. Stops before running when every
#                    surface reached the target (exit 0) or the rounds are used up
#                    (exit 4: escalate).
#   --target-grade N grade 1-5 a looped surface must reach (default 4)
#   --max-rounds N   loop rounds after the full run (default 3)
#   --previous DIR   the merged run to loop from (default: the newest graded run)
#   --dry-run        with --loop: print the decision and the selected tests, run nothing
#
# Triggered by hand only: never scheduled, never part of per-PR or nightly CI
# (tests marked product_run are deselected without --product-run).
#
# Output: tests/system/artifacts/product-run/<run id>/ with index.html (the page),
# status.json, results.json, shots/<step>.png and shots/manifest.json, and the
# UI-review hand-off review/ (review-brief.md, review-request.json, contact sheets;
# scripts/internal/product-run-review.py merges the reviewers' findings).
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
REAL_POINTER=0
LOOP=""
TARGET_GRADE=4
MAX_ROUNDS=3
PREVIOUS=""
DRY_RUN=0
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
    --real-pointer) REAL_POINTER=1 ;;
    --loop | --target-grade | --max-rounds | --previous)
        [ "$#" -ge 2 ] || { echo "$1 needs a value" >&2; exit 2; }
        case "$1" in
        --loop) LOOP="$2" ;;
        --target-grade) TARGET_GRADE="$2" ;;
        --max-rounds) MAX_ROUNDS="$2" ;;
        --previous) PREVIOUS="$2" ;;
        esac
        shift
        ;;
    --dry-run) DRY_RUN=1 ;;
    -h | --help) usage; exit 0 ;;
    --) shift; PYTEST_ARGS=("$@"); break ;;
    *) echo "unknown argument: $1 (see --help)" >&2; exit 2 ;;
    esac
    shift
done

cd "$REPO"

# --- review loop: decide the round before building or starting anything ----------
LOOP_ARGS=()
if [ -n "$LOOP" ]; then
    LOOP_ARGS=(--surfaces "$LOOP" --target-grade "$TARGET_GRADE" --max-rounds "$MAX_ROUNDS")
    if [ -n "$PREVIOUS" ]; then LOOP_ARGS+=(--previous "$(cd "$PREVIOUS" && pwd)"); fi
    set +e
    ./scripts/internal/product-run-review.py loop-plan "${LOOP_ARGS[@]}"
    PLAN_RC=$?
    set -e
    case "$PLAN_RC" in
    0) ;;
    10) echo "review loop done: every looped surface reached grade $TARGET_GRADE"; exit 0 ;;
    11) echo "review loop exhausted: escalate the surfaces still below the target" >&2; exit 4 ;;
    *) exit 2 ;;
    esac
    if [ "$DRY_RUN" -eq 1 ]; then
        echo "dry run: nothing started"
        exit 0
    fi
elif [ "$DRY_RUN" -eq 1 ]; then
    echo "--dry-run needs --loop" >&2
    exit 2
fi

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
    # --build covers the RDP steps too (sidecar + rdp_test_server); the implicit
    # first build stays quick and skips them unless asked.
    SKIP_RDP="${TERMIHUB_SKIP_RDP_HELPER:-$([ "$BUILD" -eq 1 ] && echo 0 || echo 1)}"
    echo "building the test app (debug, with the test bridge; RDP sidecar skipped=$SKIP_RDP)..."
    TERMIHUB_SKIP_RDP_HELPER="$SKIP_RDP" ./scripts/internal/build-system-test-app.sh --debug
fi

# A locked screen stops WKWebView from painting and from answering the test
# bridge, so every step would time out one by one (#5536). Refuse up front.
# (captured first: with pipefail, `ioreg | grep -q` fails on ioreg's SIGPIPE)
CONSOLE_STATE="$( [ "$(uname -s)" = "Darwin" ] && ioreg -n Root -d1 2>/dev/null || true)"
if case "$CONSOLE_STATE" in *'"CGSSessionScreenIsLocked"=Yes'*) true ;; *) false ;; esac; then
    echo "the screen is locked: unlock it and keep the display awake for the run" >&2
    exit 1
fi
# Keep the display (and so the unlocked session) awake while this script runs.
if command -v caffeinate > /dev/null 2>&1; then caffeinate -di -w $$ & fi

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
# The commit the run was made from: the review loop lists PRs between two runs.
printf '{"commit": "%s"}\n' "$(git rev-parse HEAD 2> /dev/null || true)" > "$RUN_DIR/run-info.json"
LOOP_NODES=()
if [ -n "$LOOP" ]; then
    ./scripts/internal/product-run-review.py loop-plan "${LOOP_ARGS[@]}" --init "$RUN_DIR" \
        --nodes-out "$RUN_DIR/loop-nodes.txt" > /dev/null
    while IFS= read -r node; do
        [ -n "$node" ] && LOOP_NODES+=("$node")
    done < "$RUN_DIR/loop-nodes.txt"
fi

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
if [ "$REAL_POINTER" -eq 1 ]; then export TERMIHUB_OS_INPUT_GLOBAL=1; fi
set +e
./tests/system/pytest.sh --product-run -m product_run -p no:cacheprovider -v -rA \
    ${LOOP_NODES[@]+"${LOOP_NODES[@]}"} ${PYTEST_ARGS[@]+"${PYTEST_ARGS[@]}"}
RC=$?
set -e

# pytest finishes the record itself; if it died first, mark the run aborted.
if [ ! -f "$RUN_DIR/results.json" ] && [ -f "$RUN_DIR/status.json" ]; then
    (cd tests/system && uv run --frozen python -c \
        'import sys; from pathlib import Path; from termihub_harness.product_run import Recorder
Recorder(Path(sys.argv[1])).finish(state="aborted", exit_status=int(sys.argv[2]))' \
        "$RUN_DIR" "$RC") || true
fi

# --- UI-review hand-off (review/ next to results.json) ----------------------------
if [ -f "$RUN_DIR/status.json" ]; then
    ./scripts/internal/product-run-review.py prepare "$RUN_DIR" ||
        echo "the review hand-off failed (the run's results are unaffected)" >&2
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
for hint in (doc.get("hints") or {}).values():
    print(f"  setup hint: {hint}")
for step in doc["steps"]:
    if step["status"] != "pass":
        print(f"  {step['status']:<10} {step['id']}: {step.get('reason') or ''}")
PYEOF
fi
echo "results: $RUN_DIR/results.json"
echo "screenshots: $RUN_DIR/shots/ (manifest.json for the UI review)"
echo "UI review: $RUN_DIR/review/review-request.json; afterwards" \
    "scripts/internal/product-run-review.py merge $RUN_DIR"
echo "page: $URL"

if [ "$KEEP_SERVING" -eq 1 ] && [ -n "$SERVER_PID" ]; then
    echo "serving the page until Ctrl-C"
    wait "$SERVER_PID" || true
fi
stop_server
exit "$RC"
