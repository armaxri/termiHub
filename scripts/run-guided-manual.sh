#!/usr/bin/env bash
# Starter for the guided-manual system-test suite (issue #957).
#
# ONE command, zero prep — just run it and answer the prompts. It:
#   1. Starts Docker if it isn't running (SSH/SFTP/X11 fixtures need it).
#   2. Loads the fixture ssh-agent key (so the agent-auth test runs, not skips).
#   3. Builds the app if stale and runs the operator suite in --manual mode.
#   4. Tees the full transcript to a gitignored log (tests/reports/manual-run.log).
#
# The SSH Docker fixtures are brought up on demand by the harness, and the local
# X11 display is resolved by the harness too (ensure_local_display), so there is
# nothing else to set up by hand.
#
# Usage (run from anywhere in the repo):
#   ./scripts/run-guided-manual.sh                 # the whole external-app suite
#   ./scripts/run-guided-manual.sh -k <selector>   # just a subset
#
# Any arguments are forwarded to pytest; with none, the external-app suite is
# selected (-k external_app). --manual, -s and -rs are always added.
set -uo pipefail

cd "$(git rev-parse --show-toplevel)"

# Select the external-app guided-manual suite unless the caller passes its own.
PYTEST_SELECT=("$@")
if [ "${#PYTEST_SELECT[@]}" -eq 0 ]; then
    PYTEST_SELECT=(-k external_app)
fi

# ── Start Docker if it isn't running (SSH/SFTP/X11 fixtures need it) ──────────
ensure_docker() {
    if docker info >/dev/null 2>&1; then
        echo "[setup] Docker is running."
        return
    fi
    echo "[setup] Docker is not running — starting it…"
    case "$(uname -s)" in
        Darwin) open -a Docker >/dev/null 2>&1 || true ;;
        Linux) systemctl --user start docker-desktop >/dev/null 2>&1 || true ;;
    esac
    for _ in $(seq 1 120); do
        docker info >/dev/null 2>&1 && {
            echo "[setup] Docker is ready."
            return
        }
        sleep 1
    done
    echo "[setup] WARNING: Docker did not become ready — SSH/SFTP/X11 tests will skip." >&2
}

# ── Load the fixture ssh-agent key (so the agent-auth test runs, not skips) ───
ensure_agent_key() {
    local key="tests/fixtures/ssh-keys/ed25519"
    ssh-add -l >/dev/null 2>&1
    if [ "$?" -eq 2 ]; then # exit 2 = no agent reachable — start one for this run
        eval "$(ssh-agent -s)" >/dev/null 2>&1 || true
    fi
    if ssh-add "$key" >/dev/null 2>&1; then
        echo "[setup] ssh-agent key loaded (agent-auth test enabled)."
    else
        echo "[setup] WARNING: could not load the ssh key — agent-auth test will skip." >&2
    fi
}

ensure_docker
ensure_agent_key

# ── Capture the full transcript to a gitignored log for later review ─────────
LOG_DIR="tests/reports"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/manual-run.log"
: >"$LOG_FILE" # truncate any previous run
echo "[setup] capturing full output to $LOG_FILE"
echo

# ── Build-if-stale + the manual suite, teed to the log ───────────────────────
# PYTHONUNBUFFERED so the interactive prompts flush promptly through the pipe.
# -rs surfaces skip reasons in the transcript so a skip is never mistaken for a run.
PYTHONUNBUFFERED=1 ./scripts/test-system-py.sh \
    --manual -s -rs "${PYTEST_SELECT[@]}" 2>&1 | tee "$LOG_FILE"
status=${PIPESTATUS[0]}

echo
echo "[done] exit=$status · full transcript: $LOG_FILE"
echo "[done] guided-manual report(s): $LOG_DIR/manual-*.json|.md"
exit "$status"
