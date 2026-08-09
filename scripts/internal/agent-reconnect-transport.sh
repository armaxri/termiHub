#!/usr/bin/env bash
# Drop / restore THIS checkout's dev-agent SSH transport for the #2476 manual
# agent-reconnect grade. Companion to scripts/internal/verify-agent-reconnect.sh.
#
# The dev agent is a loopback sshd on this checkout's `dev_agent_port` (from
# dev.local.json), started by `scripts/dev.sh`. "Dropping" the transport means
# severing ONLY the SSH transport: kill the sshd master listener AND its
# per-connection `sshd:` child handlers, but do NOT touch the `termihub-agent`
# process or the detached session daemon it spawned. Killing sshd is enough — the
# SSH channel closes, the agent's stdio hits EOF and it exits on its own, and the
# `setsid`'d session daemon (reparented to PID 1) survives, exactly as it does in
# a real transport drop. That surviving daemon is the whole point of the recovery
# grade: on `restore`, the backend re-establishes the transport and the fresh
# agent re-attaches it.
#
# This is deliberately NOT a recursive PPID-tree reap of the sshd master. At the
# instant of the drop the agent's session daemon is still a PPID-child of the live
# `termihub-agent` (setsid changed its session/pgroup, NOT its PPID), so a
# descendants() walk would kill the daemon too — the #2508 bug that made recovery
# find a dead socket and fall back to a NEW shell, a false failure that invalidated
# the #2476 grade. `setsid` protects the daemon from sshd's SIGHUP-on-teardown, not
# from an explicit PPID-tree kill, so the kill list is restricted to sshd processes.
# With the listener gone, backend reconnect attempts fail, which is exactly the
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
# list reaps leaves first.
descendants() {
    local pid="$1" child
    for child in $(pgrep -P "$pid" 2>/dev/null || true); do
        descendants "$child"
        printf '%s\n' "$child"
    done
}

# The basename of a PID's executable command (empty if the process is gone).
# `ps -o comm=` returns the exec path on macOS (`/usr/sbin/sshd`) and the process
# name on Linux (`sshd`); the basename normalises both.
comm_of() {
    local comm
    comm=$(ps -o comm= -p "$1" 2>/dev/null | awk 'NR==1{print $1}')
    printf '%s' "${comm##*/}"
}

# The SSH-transport kill list: every sshd-family process holding a socket on our
# loopback dev-agent port — matched by comm `sshd` OR `sshd-*` (OpenSSH 9.8+ /
# macOS 26 split the per-connection handler into a separate `sshd-session` /
# `sshd-sess` process). Found via the PORT socket (`lsof -iTCP:PORT`), NOT by
# walking a master's descendants, so it still finds an ESTABLISHED session that
# outlived its master listener (the #2510 case: the master had already exited but
# a live `sshd-session` kept the agent connection up, so the descendant-walk found
# nothing and `drop` wrongly reported "already down").
#
# Crucially this still EXCLUDES the `termihub-agent --stdio` process the SSH
# session runs and the `setsid`'d session daemon that agent spawned: their comm is
# `termihub`/`termihub-agent`, not `sshd*`, so the case match skips them. At drop
# time the daemon is still a PPID-child of the live agent (setsid changed its
# session/pgroup, not its PPID), so a naive `descendants()` reap would kill it and
# reproduce the #2508 false failure. Matching only sshd-family comm on the port
# socket severs only the transport; the agent then EOFs and exits on its own, and
# the detached daemon survives for the recovery grade.
sshd_transport_pids() {
    local pid
    for pid in $(lsof -nP -iTCP:"$PORT" -t 2>/dev/null | sort -u); do
        case "$(comm_of "$pid")" in
        sshd | sshd-*) printf '%s\n' "$pid" ;;
        esac
    done
}

# True while any sshd-family transport process (master listener OR an established
# session that outlived it) still holds a socket on the dev-agent port.
transport_up() { [ -n "$(sshd_transport_pids)" ]; }

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
    # Collect every sshd-family transport process on our port — the master
    # listener AND/OR any ESTABLISHED session that outlived it (#2510). Empty
    # means the transport really is severed already.
    local victims
    victims="$(sshd_transport_pids | tr '\n' ' ')"
    if [ -z "${victims// /}" ]; then
        echo "[transport] already down — no sshd transport on 127.0.0.1:$PORT."
        return 0
    fi

    # Remember the config (host key) so restore relaunches an identical sshd.
    # config_of falls back to the newest dev.sh sshd_config dir when the master
    # listener is already gone (no pid to read `-f` from).
    local cfg
    cfg="$(config_of "$(listener_pid)")"
    mkdir -p "$STATE_DIR"
    {
        printf 'config=%s\n' "$cfg"
        printf 'sshd=%s\n' "$(find_sshd_binary)"
    } >"$STATE_FILE"

    # Reap the sshd master AND its per-connection handlers so the established SSH
    # transport is severed at once — but NOT the agent process or its detached
    # session daemon (see sshd_transport_pids / #2508). The agent then EOFs and
    # exits on its own; the setsid'd daemon survives for recovery.
    # shellcheck disable=SC2086 # word-splitting the PID list is intended.
    kill -TERM $victims 2>/dev/null || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do
        transport_up || break
        sleep 0.2
    done
    if transport_up; then
        # Re-collect: established children may have been re-forked with new pids.
        victims="$(sshd_transport_pids | tr '\n' ' ')"
        # shellcheck disable=SC2086
        kill -KILL $victims 2>/dev/null || true
        for _ in 1 2 3 4 5; do
            transport_up || break
            sleep 0.2
        done
    fi

    if transport_up; then
        echo "[transport] WARNING: sshd transport still up on :$PORT after kill." >&2
        return 1
    fi
    echo "[transport] DROPPED — dev-agent SSH transport on 127.0.0.1:$PORT is severed."
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
