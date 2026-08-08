#!/usr/bin/env bash
# Drop / restore THIS checkout's dev-agent SSH transport for the #2476 manual
# agent-reconnect grade. Companion to scripts/internal/verify-agent-reconnect.sh.
#
# The dev agent is a loopback sshd on this checkout's `dev_agent_port` (from
# dev.local.json), started by `scripts/dev.sh`. "Dropping" the transport means
# killing that sshd — the master listener AND every established-connection child —
# so an in-flight agent session is severed at once (killing only the listener
# leaves the established connection alive; see tests' LocalAgentSshd.stop). With
# the listener gone, backend reconnect attempts fail, which is exactly the
# prolonged outage that forces the backend park/retry loop under the
# `sessionBackendReattach` flag.
#
# "Restoring" relaunches sshd from the SAME config file (hence the SAME host key),
# so the app's trust store still trusts it and the backend-driven reconnect is not
# blocked on a host-key prompt it cannot answer.
#
# Usage (run in a SECOND terminal while verify-agent-reconnect.sh runs):
#   scripts/internal/agent-reconnect-transport.sh drop      # sever the transport
#   scripts/internal/agent-reconnect-transport.sh restore   # bring it back
#   scripts/internal/agent-reconnect-transport.sh status    # is it listening?
#
# Operates ONLY on this checkout's own dev-agent sshd (resolved by its dedicated
# loopback port), never on shared Docker fixtures and never via pattern-pkill.
set -euo pipefail

# Resolve the repo root from THIS script's own location (scripts/internal/ ->
# ../.. is the repo root), NOT from the current working directory. This lets the
# script be invoked by absolute path from anywhere — including outside any git
# repo — without `git rev-parse` failing on the CWD.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"

STATE_DIR=".dev-agent"
STATE_FILE="$STATE_DIR/agent-reconnect-transport.state"

# ── Resolve this checkout's dev-agent port from dev.local.json ────────────────
resolve_port() {
    local port=""
    if [ -f "dev.local.json" ]; then
        port=$(grep -oE '"dev_agent_port"[[:space:]]*:[[:space:]]*[0-9]+' dev.local.json \
            | grep -oE '[0-9]+$' || true)
    fi
    if [[ ! "$port" =~ ^[0-9]+$ ]]; then
        echo "error: no dev_agent_port in dev.local.json — is this a dev checkout?" >&2
        exit 1
    fi
    printf '%s' "$port"
}

PORT="$(resolve_port)"

find_sshd_binary() {
    local candidate
    for candidate in /usr/sbin/sshd /sbin/sshd; do
        [ -x "$candidate" ] && { printf '%s' "$candidate"; return; }
    done
    command -v sshd || true
}

# The PID of the sshd master listening on our loopback port (empty if none).
listener_pid() {
    lsof -nP -iTCP@127.0.0.1:"$PORT" -sTCP:LISTEN -t 2>/dev/null | head -1 || true
}

is_listening() {
    [ -n "$(listener_pid)" ]
}

# Every descendant PID of $1, depth-first (children before parents), so a kill
# list reaps leaves first — mirrors LocalAgentSshd.stop's recursive reap.
descendants() {
    local pid="$1" child
    for child in $(pgrep -P "$pid" 2>/dev/null || true); do
        descendants "$child"
        printf '%s\n' "$child"
    done
}

# The sshd config path of a running master: prefer its own argv (`-f <path>`),
# else fall back to the newest dev.sh-created sshd config dir.
config_of() {
    local pid="$1" cfg=""
    if [ -n "$pid" ]; then
        cfg=$(ps -o command= -p "$pid" 2>/dev/null \
            | sed -n 's/.*-f \([^ ][^ ]*\).*/\1/p' || true)
    fi
    if [ -z "$cfg" ] || [ ! -f "$cfg" ]; then
        # These are our own mktemp dirs (termihub-dev-sshd.XXXX) — safe names, so
        # the SC2012 non-alphanumeric caveat cannot apply, and `ls -td` is portable
        # across macOS/Linux where a `find -exec stat` mtime sort is not.
        # shellcheck disable=SC2012
        cfg=$(ls -td /tmp/termihub-dev-sshd.*/sshd_config 2>/dev/null | head -1 || true)
    fi
    printf '%s' "$cfg"
}

do_drop() {
    local master
    master="$(listener_pid)"
    if [ -z "$master" ]; then
        echo "[transport] already down — nothing listening on 127.0.0.1:$PORT."
        return 0
    fi

    # Remember the config (host key) so restore relaunches an identical sshd.
    local cfg
    cfg="$(config_of "$master")"
    mkdir -p "$STATE_DIR"
    {
        printf 'config=%s\n' "$cfg"
        printf 'sshd=%s\n' "$(find_sshd_binary)"
    } >"$STATE_FILE"

    # Reap the master AND its per-connection children so the established agent
    # transport is severed at once, not just the listener.
    local victims
    victims="$(descendants "$master") $master"
    # shellcheck disable=SC2086 # word-splitting the PID list is intended.
    kill -TERM $victims 2>/dev/null || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do
        is_listening || break
        sleep 0.2
    done
    if is_listening; then
        # shellcheck disable=SC2086
        kill -KILL $victims 2>/dev/null || true
        for _ in 1 2 3 4 5; do
            is_listening || break
            sleep 0.2
        done
    fi

    if is_listening; then
        echo "[transport] WARNING: sshd still listening on :$PORT after kill." >&2
        return 1
    fi
    echo "[transport] DROPPED — dev-agent sshd on 127.0.0.1:$PORT is down."
    echo "[transport] the agent tab should go Reconnecting; run 'restore' to bring it back,"
    echo "[transport] or leave it down to watch the permanent-drop -> Disconnected case."
}

do_restore() {
    if is_listening; then
        echo "[transport] already up — sshd is listening on 127.0.0.1:$PORT."
        return 0
    fi

    local cfg="" sshd_bin=""
    if [ -f "$STATE_FILE" ]; then
        # shellcheck disable=SC1090
        cfg=$(sed -n 's/^config=//p' "$STATE_FILE")
        sshd_bin=$(sed -n 's/^sshd=//p' "$STATE_FILE")
    fi
    [ -z "$cfg" ] || [ ! -f "$cfg" ] && cfg="$(config_of "")"
    [ -x "$sshd_bin" ] || sshd_bin="$(find_sshd_binary)"

    if [ -z "$cfg" ] || [ ! -f "$cfg" ]; then
        echo "error: no dev-agent sshd config found to restore from." >&2
        echo "       (run verify-agent-reconnect.sh first, then 'drop' before 'restore'.)" >&2
        exit 1
    fi
    if [ -z "$sshd_bin" ]; then
        echo "error: no sshd binary found." >&2
        exit 1
    fi

    # Relaunch exactly as scripts/dev.sh does (daemonizes; reuses host key), so the
    # restored transport is trusted and the backend reconnect just re-establishes.
    "$sshd_bin" -f "$cfg"
    for _ in $(seq 1 50); do
        is_listening && break
        sleep 0.1
    done
    if is_listening; then
        echo "[transport] RESTORED — dev-agent sshd is listening on 127.0.0.1:$PORT again."
        echo "[transport] the agent tab should reconnect (backend-driven) and re-attach live."
    else
        echo "[transport] WARNING: sshd did not come back up on :$PORT." >&2
        return 1
    fi
}

do_status() {
    if is_listening; then
        echo "[transport] UP — sshd listening on 127.0.0.1:$PORT (pid $(listener_pid))."
    else
        echo "[transport] DOWN — nothing listening on 127.0.0.1:$PORT."
    fi
}

case "${1:-}" in
    drop) do_drop ;;
    restore) do_restore ;;
    status) do_status ;;
    *)
        echo "usage: $0 {drop|restore|status}" >&2
        exit 2
        ;;
esac
