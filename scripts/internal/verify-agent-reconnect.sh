#!/usr/bin/env bash
# TURNKEY manual test for the #2476 backend-driven agent-reconnect grade.
#
# ONE command, zero setup. It:
#   1. Enables experimental features in the app's settings.json (so the dev
#      agent's "Remote Agents" sidebar group renders), preserving other settings.
#   2. Turns the `sessionBackendReattach` flag ON without you editing anything,
#      via the #2481 test-bridge env->window injection
#      (TERMIHUB_TEST_FLAG_SESSION_BACKEND_REATTACH -> window.__TERMIHUB_SESSION_BACKEND_REATTACH__).
#      This is an operator-watched grade on a real display, so the window is left
#      as a NORMAL, backgroundable window (TERMIHUB_TEST_NO_ALWAYS_ON_TOP=1, #2504)
#      — you keep it visible yourself, so occlusion-throttling isn't a concern and
#      you can freely background it to read this checklist / use a second terminal.
#   3. Launches this checkout's dev agent + the app via `scripts/dev.sh` (builds if
#      stale; the dev agent sshd + connection are set up for you). The window stays
#      in the foreground so you can watch the reconnect.
#
# Then follow the printed checklist (3-6 clicks, ~5 min). A companion command,
# scripts/internal/agent-reconnect-transport.sh, drops/restores the dev-agent
# transport with one keystroke — you never have to find a PID or a port.
#
# Unix/macOS only: the dev agent (a loopback sshd) is Unix-only, exactly as
# scripts/dev.sh documents, so there is no .cmd sibling.
#
# Usage (run from anywhere in the repo):
#   scripts/internal/verify-agent-reconnect.sh
set -euo pipefail

# Resolve the repo root from THIS script's own location (scripts/internal/ ->
# ../.. is the repo root), NOT from the current working directory. This lets the
# script be invoked by absolute path from anywhere — including outside any git
# repo — without `git rev-parse` failing on the CWD.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"

if [[ "$(uname)" != "Darwin" && "$(uname)" != "Linux" ]]; then
    echo "error: this manual test is Unix/macOS only (the dev agent is a loopback sshd)." >&2
    exit 1
fi

TRANSPORT="$REPO_ROOT/scripts/internal/agent-reconnect-transport.sh"
STATE_FILE="$REPO_ROOT/.dev-agent/agent-reconnect-transport.state"

# ── This checkout's dev-agent port + label (from dev.local.json) ──────────────
DEV_AGENT_PORT=""
DEV_NAME=""
if [ -f "dev.local.json" ]; then
    DEV_AGENT_PORT=$(grep -oE '"dev_agent_port"[[:space:]]*:[[:space:]]*[0-9]+' dev.local.json \
        | grep -oE '[0-9]+$' || true)
    DEV_NAME=$(grep -oE '"dev_name"[[:space:]]*:[[:space:]]*"[^"]+"' dev.local.json \
        | grep -oE '"[^"]+"$' | tr -d '"' || true)
fi
if [[ ! "$DEV_AGENT_PORT" =~ ^[0-9]+$ ]]; then
    echo "error: no dev_agent_port in dev.local.json — scripts/dev.sh won't start a dev agent." >&2
    exit 1
fi
AGENT_LABEL="Dev Agent (${DEV_NAME:-:$DEV_AGENT_PORT})"

# ── App config dir (mirrors scripts/dev.sh) ──────────────────────────────────
if [[ "$(uname)" == "Darwin" ]]; then
    CFG_DIR="$HOME/Library/Application Support/com.termihub.app"
else
    CFG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/com.termihub.app"
fi

# ── Enable experimental features so the Remote Agents group renders ───────────
# Region-authoritative settings are seeded from settings.json at startup (#2386),
# so writing it before launch is enough. Read-modify-write preserves other keys.
seed_experimental_features() {
    python3 - "$CFG_DIR/settings.json" << 'PYEOF'
import json, os, sys
path = sys.argv[1]
os.makedirs(os.path.dirname(path), exist_ok=True)
data = {}
if os.path.exists(path):
    try:
        loaded = json.load(open(path))
        if isinstance(loaded, dict):
            data = loaded
    except (OSError, ValueError):
        data = {}
data.setdefault("version", "1")
data["experimentalFeaturesEnabled"] = True
with open(path, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
print(f"[setup] experimental features enabled in {path}")
PYEOF
}

# ── A free loopback port to trigger the test-bridge init-script (flag inject) ──
# Nothing needs to listen there — the port's only job is to register the bridge
# plugin so the flag global is injected (the window is NOT pinned always-on-top
# here; see TERMIHUB_TEST_NO_ALWAYS_ON_TOP below, #2504).
pick_bridge_port() {
    local port
    for port in 47600 47601 47602 47603 47604; do
        if ! lsof -nP -iTCP:"$port" -sTCP:LISTEN -t >/dev/null 2>&1; then
            printf '%s' "$port"
            return
        fi
    done
    printf '%s' 47600
}
BRIDGE_PORT="$(pick_bridge_port)"

cleanup() { rm -f "$STATE_FILE" 2>/dev/null || true; }
trap cleanup EXIT

seed_experimental_features
rm -f "$STATE_FILE" 2>/dev/null || true

cat <<CHECKLIST

============================================================================
  AGENT RECONNECT — TURNKEY MANUAL TEST (#2476)   flag: sessionBackendReattach ON
============================================================================

The app is about to launch (first run BUILDS — this can take a few minutes).
Keep THIS terminal open (it runs the app). Do the drop/restore in a SECOND
terminal with the one-liners below.

The termiHub window is a NORMAL, backgroundable window (not pinned on top) — you
can freely switch to this terminal / another app to read these steps.

  DROP transport (sever the dev-agent SSH):
      $TRANSPORT drop
  RESTORE transport (bring it back):
      $TRANSPORT restore

----------------------------------------------------------------------------
FOLLOW THESE STEPS (each line states the expected result):
----------------------------------------------------------------------------
1. Wait for the termiHub window. In the Connections sidebar, expand
   "Remote Agents" -> you should see "$AGENT_LABEL".

2. Right-click "$AGENT_LABEL" -> Connect. If a host-key prompt appears, choose
   Accept/trust it.
   EXPECT: the agent's state becomes "Connected".

3. Right-click the connected agent -> "New Shell Session". In the new tab type:
      echo hello
   EXPECT: a live shell that prints "hello".

4. In the SECOND terminal run:  $TRANSPORT drop
   EXPECT: within a few seconds the agent tab shows "Reconnecting..." (it must
   NOT close, exit, or vanish — the terminal stays, backend-driven).

5. Wait ~30s (let the backend park + retry a prolonged outage), then run:
      $TRANSPORT restore
   EXPECT: the agent reconnects BACKEND-DRIVEN and the SAME shell tab re-attaches
   to a fresh backend session. Type:  echo hello2
   -> it prints "hello2". No duplicate tab, no second connection.

6. PERMANENT-DROP case: run  $TRANSPORT drop  again and DO NOT restore.
   EXPECT: after the backend gives up retrying, the agent/tab settles
   "Disconnected" (it must not spin forever and must not be left stranded).

Done: PASS = steps 5 (reattach live, no double-connect) and 6 (clean
Disconnected) both hold. Close the window / press Ctrl-C here to tear down
(the dev agent sshd is stopped automatically).
============================================================================

CHECKLIST

# The flag injection requires the test-bridge plugin, which the backend registers
# only when TERMIHUB_TEST_BRIDGE_PORT parses. Nothing listens on BRIDGE_PORT — the
# app's bridge client just logs a failed connect (harmless).
export TERMIHUB_TEST_BRIDGE_PORT="$BRIDGE_PORT"
export TERMIHUB_TEST_FLAG_SESSION_BACKEND_REATTACH=1
# Opt out of the test-bridge always-on-top pin (#2504): this is an operator-watched
# grade on a real display, so the operator keeps the window visible themselves —
# leaving it a normal, backgroundable window instead of forcing it above everything.
export TERMIHUB_TEST_NO_ALWAYS_ON_TOP=1

# Not `exec`: run as a child so the EXIT trap (state-file cleanup) still fires
# when the app closes. scripts/dev.sh owns stopping its own dev-agent sshd.
./scripts/dev.sh
