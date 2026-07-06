#!/usr/bin/env bash
# Starter for the guided-manual system-test suite (issue #957).
#
# One command to run the interactive operator suite with everything set up:
#   1. Builds the app if stale and brings up the SSH Docker fixtures
#      (ssh-password, ssh-keys, ssh-x11) via scripts/test-system-py.sh.
#   2. Runs the suite in --manual mode and tees ALL output to a gitignored log
#      (tests/reports/manual-run.log) so the run can be reviewed afterwards —
#      the operator answers prompts live while the transcript is captured.
#
# The local X11 display the X11-forwarding test needs is resolved by the harness
# itself (termihub_harness.ensure_local_display, started from the app-launch
# fixture), so it works for every entrypoint — not just this script — and you
# never export DISPLAY by hand.
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

# ── Capture the full transcript to a gitignored log for later review ─────────
LOG_DIR="tests/reports"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/manual-run.log"
: >"$LOG_FILE" # truncate any previous run
echo "[setup] capturing full output to $LOG_FILE"
echo

# ── Build-if-stale + fixtures + the manual suite, teed to the log ────────────
# PYTHONUNBUFFERED so the interactive prompts flush promptly through the pipe.
# -rs surfaces skip reasons in the transcript (e.g. an unloaded ssh-agent key),
# so a skipped test is never silently mistaken for "ran".
PYTHONUNBUFFERED=1 ./scripts/test-system-py.sh \
    --fixtures "ssh-password ssh-keys ssh-x11" \
    --manual -s -rs "${PYTEST_SELECT[@]}" 2>&1 | tee "$LOG_FILE"
status=${PIPESTATUS[0]}

echo
echo "[done] exit=$status · full transcript: $LOG_FILE"
echo "[done] guided-manual report(s): $LOG_DIR/manual-*.json|.md"
exit "$status"
