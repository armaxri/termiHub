#!/usr/bin/env bash
# Starter for the guided-manual system-test suite (issue #957).
#
# One command to run the interactive operator suite with everything set up:
#   1. Resolves the local X11 display per-OS (XQuartz on macOS; native $DISPLAY
#      on Linux; skipped on Windows, where the X11 test doesn't apply) — so you
#      never export DISPLAY by hand.
#   2. Builds the app if stale and brings up the SSH Docker fixtures
#      (ssh-password, ssh-keys, ssh-x11) via scripts/test-system-py.sh.
#   3. Runs the suite in --manual mode and tees ALL output to a gitignored log
#      (tests/reports/manual-run.log) so the run can be reviewed afterwards —
#      the operator answers prompts live while the transcript is captured.
#
# Usage (run from anywhere in the repo):
#   ./scripts/run-guided-manual.sh                 # the whole external-app suite
#   ./scripts/run-guided-manual.sh -k test_terminal_clipboard_copy_paste
#   ./scripts/run-guided-manual.sh -k external_app -x
#
# Any arguments are forwarded to pytest; with none, the external-app suite is
# selected (-k external_app). --manual and -s are always added.
set -uo pipefail

cd "$(git rev-parse --show-toplevel)"

# Select the external-app guided-manual suite unless the caller passes its own.
PYTEST_SELECT=("$@")
if [ "${#PYTEST_SELECT[@]}" -eq 0 ]; then
    PYTEST_SELECT=(-k external_app)
fi

# ── Per-OS X11 display (the X11-forwarding test needs a local X server) ───────
case "$(uname -s)" in
    Darwin)
        # XQuartz publishes DISPLAY through launchd; start it if it isn't up yet.
        DISPLAY_VAL="$(launchctl getenv DISPLAY 2>/dev/null || true)"
        if [ -z "$DISPLAY_VAL" ]; then
            echo "[setup] starting XQuartz for X11 forwarding…"
            open -a XQuartz >/dev/null 2>&1 || true
            for _ in $(seq 1 15); do
                DISPLAY_VAL="$(launchctl getenv DISPLAY 2>/dev/null || true)"
                [ -n "$DISPLAY_VAL" ] && break
                sleep 1
            done
        fi
        [ -n "$DISPLAY_VAL" ] && export DISPLAY="$DISPLAY_VAL"
        ;;
    Linux)
        # Native X: DISPLAY is normally already set in a desktop session.
        export DISPLAY="${DISPLAY:-:0}"
        ;;
    MINGW* | MSYS* | CYGWIN*)
        # Windows: the X11-forwarding test skips (macOS/Linux feature); no DISPLAY.
        : ;;
esac
echo "[setup] DISPLAY=${DISPLAY:-<unset>}"

# ── Capture the full transcript to a gitignored log for later review ─────────
LOG_DIR="tests/reports"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/manual-run.log"
: >"$LOG_FILE" # truncate any previous run
echo "[setup] capturing full output to $LOG_FILE"
echo

# ── Build-if-stale + fixtures + the manual suite, teed to the log ────────────
# PYTHONUNBUFFERED so the interactive prompts flush promptly through the pipe.
PYTHONUNBUFFERED=1 ./scripts/test-system-py.sh \
    --fixtures "ssh-password ssh-keys ssh-x11" \
    --manual -s "${PYTEST_SELECT[@]}" 2>&1 | tee "$LOG_FILE"
status=${PIPESTATUS[0]}

echo
echo "[done] exit=$status · full transcript: $LOG_FILE"
echo "[done] guided-manual report(s): $LOG_DIR/manual-*.json|.md"
exit "$status"
