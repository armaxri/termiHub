#!/usr/bin/env bash
#
# Native loopback sshd fixture for the SSH/SFTP live suites (CI-020, TIN-007).
#
# The Docker SSH fixtures (tests/docker) only run on Linux: the GitHub-hosted
# macOS runners have no container runtime and the Windows runners only run
# Windows containers. This script stands up the platform's OWN OpenSSH server
# instead, so the sshd-only journeys (core/tests/ssh_native.rs and the agent
# reconnect UI grade) run on macOS and Windows as well as Linux.
#
# macOS / Linux: runs the system /usr/sbin/sshd UNPRIVILEGED as the current
# user -- a temporary ed25519 host key, a temporary client key, an
# authorized_keys file (the repo's fixture keys + the client key), a
# non-standard loopback port, `UsePAM no` / `StrictModes no`. No root, no
# change to the system sshd. Only the current user can log in (an unprivileged
# sshd cannot switch users), so TERMIHUB_NATIVE_SSHD_USER is the current user.
#
# Windows (Git Bash): parses the same options, then hands over to
# native-sshd-fixture.ps1 under pwsh, which runs Win32-OpenSSH as SYSTEM from a
# dedicated scheduled task plus a local test user (elevated shell required, as
# on the GitHub windows runner). Its default --dir is %ProgramData%\termihub-native-sshd.
#
# Usage:
#   scripts/internal/native-sshd-fixture.sh up    [--dir DIR] [--port N] [--github-env]
#                                                 [--agent-binary PATH]
#   scripts/internal/native-sshd-fixture.sh stop  [--dir DIR]   # listener down, state kept
#   scripts/internal/native-sshd-fixture.sh start [--dir DIR]   # restart after stop
#   scripts/internal/native-sshd-fixture.sh env   [--dir DIR] [--github-env]
#   scripts/internal/native-sshd-fixture.sh down  [--dir DIR]   # stop + delete all state
#
# `up` creates the state, starts sshd, proves a real `ssh -p` login + sftp
# subsystem works, and prints `export NAME='value'` lines (eval-able) for:
#   TERMIHUB_NATIVE_SSHD=1           the flag the suites gate on (and require)
#   TERMIHUB_NATIVE_SSHD_PORT        loopback port sshd listens on
#   TERMIHUB_NATIVE_SSHD_USER        login user
#   TERMIHUB_NATIVE_SSHD_KEY         unencrypted ed25519 client private key
#   TERMIHUB_NATIVE_SSHD_HOST_PUBKEY the sshd host public key (known_hosts)
#   TERMIHUB_NATIVE_SSHD_DIR         state dir (pass back to stop/start/down)
#   TERMIHUB_NATIVE_SSHD_AGENT_BIN   with --agent-binary: a termihub-agent the
#                                    login user can run (Windows copies it into
#                                    the state dir; macOS/Linux use it as is)
# `--github-env` also appends them to "$GITHUB_ENV" for later workflow steps.
#
# Default --dir: $RUNNER_TEMP/termihub-native-sshd on CI, else
# ${TMPDIR:-/tmp}/termihub-native-sshd-<user>. Default port: first free of
# 22400+TERMIHUB_TEST_PORT_OFFSET .. +49 (below every ephemeral range, so no
# port-0 bind can take it; the offset keeps parallel checkouts apart).
#
# `down` kills only the sshd whose PID is recorded in the state dir (and that
# master's own per-connection children), after checking the PID still names an
# sshd -- never a name pattern.

set -euo pipefail

usage() {
  sed -n '3,51p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

case "${1:-}" in
  -h | --help | help)
    usage
    exit 0
    ;;
esac

ACTION="${1:-}"
[ -n "$ACTION" ] || {
  usage >&2
  exit 2
}
shift

STATE_DIR=""
PORT=""
GITHUB_ENV_OUT=0
AGENT_BIN=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dir)
      STATE_DIR="${2:?--dir needs a value}"
      shift 2
      ;;
    --port)
      PORT="${2:?--port needs a value}"
      shift 2
      ;;
    --github-env)
      GITHUB_ENV_OUT=1
      shift
      ;;
    --agent-binary)
      AGENT_BIN="${2:?--agent-binary needs a value}"
      shift 2
      ;;
    *)
      echo "error: unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

# Windows: the Win32-OpenSSH provisioning lives in the PowerShell twin.
case "$(uname -s)" in
  MINGW* | MSYS* | CYGWIN*)
    ps_args=(-Action "$ACTION")
    [ -z "$STATE_DIR" ] || ps_args+=(-Dir "$(cygpath -w "$STATE_DIR")")
    [ -z "$PORT" ] || ps_args+=(-Port "$PORT")
    [ "$GITHUB_ENV_OUT" -eq 0 ] || ps_args+=(-GitHubEnv)
    [ -z "$AGENT_BIN" ] || ps_args+=(-AgentBinary "$(cygpath -w "$AGENT_BIN")")
    exec pwsh -NoProfile -ExecutionPolicy Bypass -File "$(cygpath -w "$SCRIPT_DIR/native-sshd-fixture.ps1")" "${ps_args[@]}"
    ;;
esac

CURRENT_USER="$(id -un)"
if [ -z "$STATE_DIR" ]; then
  if [ -n "${RUNNER_TEMP:-}" ]; then
    STATE_DIR="$RUNNER_TEMP/termihub-native-sshd"
  else
    STATE_DIR="${TMPDIR:-/tmp}"
    STATE_DIR="${STATE_DIR%/}/termihub-native-sshd-$CURRENT_USER"
  fi
fi

HOST_KEY="$STATE_DIR/host_ed25519_key"
CLIENT_KEY="$STATE_DIR/client_ed25519_key"
AUTH_KEYS="$STATE_DIR/authorized_keys"
CONFIG="$STATE_DIR/sshd_config"
PID_FILE="$STATE_DIR/sshd.pid"
LOG_FILE="$STATE_DIR/sshd.log"
PORT_FILE="$STATE_DIR/port"
AGENT_BIN_FILE="$STATE_DIR/agent_bin"

log() { echo "native-sshd: $*" >&2; }
die() {
  log "error: $*"
  exit 1
}

find_sshd() {
  local cand
  # sshd refuses to re-exec unless started by an absolute path.
  for cand in /usr/sbin/sshd /sbin/sshd /usr/local/sbin/sshd; do
    [ -x "$cand" ] && {
      echo "$cand"
      return 0
    }
  done
  command -v sshd 2>/dev/null || return 1
}

port_in_use() {
  # A successful connect means something already listens there.
  (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null
}

wait_listening() {
  local port="$1" i
  for i in $(seq 1 100); do
    port_in_use "$port" && return 0
    # Give up early if sshd already died (bad config, port taken).
    if [ -f "$PID_FILE" ] && ! kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
      return 1
    fi
    [ "$i" -eq 100 ] || sleep 0.1
  done
  return 1
}

# The PID recorded in the state dir, only if it still names OUR sshd: an sshd
# whose command line carries this fixture's config path (sshd's proctitle keeps
# it: "sshd: /usr/sbin/sshd -f <config> ... [listener]"). A recycled PID fails.
recorded_sshd_pid() {
  local pid args
  [ -f "$PID_FILE" ] || return 1
  pid="$(tr -dc '0-9' <"$PID_FILE")"
  [ -n "$pid" ] || return 1
  args="$(ps -o args= -p "$pid" 2>/dev/null || true)"
  case "$args" in
    *sshd*"$CONFIG"*) echo "$pid" ;;
    *) return 1 ;;
  esac
}

write_config() {
  cat >"$CONFIG" <<EOF
# Generated by scripts/internal/native-sshd-fixture.sh -- test-only, loopback.
Port $PORT
ListenAddress 127.0.0.1
HostKey $HOST_KEY
PidFile $PID_FILE
AuthorizedKeysFile $AUTH_KEYS
PubkeyAuthentication yes
PasswordAuthentication no
KbdInteractiveAuthentication no
UsePAM no
StrictModes no
AllowTcpForwarding yes
AllowUsers $CURRENT_USER
Subsystem sftp internal-sftp
LogLevel VERBOSE
# The suites open many sessions at once (key matrix, parallel tests); the
# default MaxStartups 10:30:100 randomly resets handshakes past 10.
MaxStartups 200:30:300
MaxSessions 100
EOF
  # OpenSSH 9.8+ penalises a source address after failed auths
  # (PerSourcePenalties), and the rejection tests fail auth on purpose from
  # 127.0.0.1, which would then refuse the next test's connection. Older sshd
  # (Ubuntu 24.04 ships 9.6) rejects the unknown keyword, so keep the line only
  # where `sshd -t` accepts it.
  local sshd
  sshd="$(find_sshd)" || die "no sshd binary found (looked in /usr/sbin, /sbin, /usr/local/sbin, PATH)"
  echo "PerSourcePenalties no" >>"$CONFIG"
  if ! "$sshd" -t -f "$CONFIG" >/dev/null 2>&1; then
    grep -v '^PerSourcePenalties ' "$CONFIG" >"$CONFIG.tmp" && mv "$CONFIG.tmp" "$CONFIG"
  fi
}

start_sshd() {
  local sshd
  sshd="$(find_sshd)" || die "no sshd binary found (looked in /usr/sbin, /sbin, /usr/local/sbin, PATH)"
  if recorded_sshd_pid >/dev/null; then
    log "sshd already running (pid $(recorded_sshd_pid))"
    return 0
  fi
  rm -f "$PID_FILE"
  # Without -D sshd daemonizes and writes PidFile; -E keeps its log with the state.
  "$sshd" -f "$CONFIG" -E "$LOG_FILE"
  wait_listening "$PORT"
}

stop_sshd() {
  local pid children
  pid="$(recorded_sshd_pid)" || {
    rm -f "$PID_FILE"
    return 0
  }
  # The master's per-connection children (sshd-session / "sshd: user@..."),
  # collected before the master goes so an established session is severed too.
  children="$(pgrep -P "$pid" 2>/dev/null || true)"
  kill "$pid" 2>/dev/null || true
  local c comm
  for c in $children; do
    # Per-connection handlers: "sshd-session: user [priv]" / "sshd: user@...".
    comm="$(ps -o args= -p "$c" 2>/dev/null || true)"
    case "$comm" in
      sshd*) kill "$c" 2>/dev/null || true ;;
    esac
  done
  local i
  for i in $(seq 1 50); do
    kill -0 "$pid" 2>/dev/null || break
    [ "$i" -eq 50 ] && kill -9 "$pid" 2>/dev/null || true
    sleep 0.1
  done
  rm -f "$PID_FILE"
}

emit_env() {
  local lines
  lines="$(
    cat <<EOF
TERMIHUB_NATIVE_SSHD=1
TERMIHUB_NATIVE_SSHD_PORT=$(cat "$PORT_FILE")
TERMIHUB_NATIVE_SSHD_USER=$CURRENT_USER
TERMIHUB_NATIVE_SSHD_KEY=$CLIENT_KEY
TERMIHUB_NATIVE_SSHD_HOST_PUBKEY=$HOST_KEY.pub
TERMIHUB_NATIVE_SSHD_DIR=$STATE_DIR
EOF
  )"
  if [ -s "$AGENT_BIN_FILE" ]; then
    lines="$lines"$'\n'"TERMIHUB_NATIVE_SSHD_AGENT_BIN=$(cat "$AGENT_BIN_FILE")"
  fi
  local line
  while IFS= read -r line; do
    printf "export %s='%s'\n" "${line%%=*}" "${line#*=}"
  done <<<"$lines"
  if [ "$GITHUB_ENV_OUT" -eq 1 ]; then
    [ -n "${GITHUB_ENV:-}" ] || die "--github-env given but GITHUB_ENV is not set"
    printf '%s\n' "$lines" >>"$GITHUB_ENV"
  fi
}

# Prove the fixture end to end with the real OpenSSH client: a login that runs
# a command, and the sftp subsystem the SFTP suites need.
self_test() {
  local opts=(-p "$PORT" -i "$CLIENT_KEY" -o BatchMode=yes -o IdentitiesOnly=yes
    -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR
    -o ConnectTimeout=10)
  local who
  who="$(ssh "${opts[@]}" "$CURRENT_USER@127.0.0.1" 'id -un')" ||
    die "ssh login to 127.0.0.1:$PORT failed (log: $LOG_FILE)"
  [ "$who" = "$CURRENT_USER" ] || die "ssh login ran as '$who', expected '$CURRENT_USER'"
  local sftp_opts=(-P "$PORT" -i "$CLIENT_KEY" -o BatchMode=yes -o IdentitiesOnly=yes
    -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR)
  echo "pwd" | sftp -q -b - "${sftp_opts[@]}" "$CURRENT_USER@127.0.0.1" >/dev/null ||
    die "sftp subsystem on 127.0.0.1:$PORT failed (log: $LOG_FILE)"
  log "self-test ok: ssh + sftp as $CURRENT_USER on 127.0.0.1:$PORT"
}

cmd_up() {
  command -v ssh-keygen >/dev/null || die "ssh-keygen not found"
  if [ -d "$STATE_DIR" ]; then
    log "state dir exists; tearing down the previous fixture first"
    cmd_down
  fi
  mkdir -p "$STATE_DIR"
  chmod 700 "$STATE_DIR"
  ssh-keygen -q -t ed25519 -N "" -C termihub-native-sshd-host -f "$HOST_KEY"
  ssh-keygen -q -t ed25519 -N "" -C termihub-native-sshd-client -f "$CLIENT_KEY"
  chmod 600 "$HOST_KEY" "$CLIENT_KEY"
  # The repo's fixture keys (every key type the Docker ssh-keys container
  # authorizes) plus the fresh client key.
  cat "$REPO_ROOT/tests/fixtures/ssh-keys/authorized_keys" "$CLIENT_KEY.pub" >"$AUTH_KEYS"
  chmod 600 "$AUTH_KEYS"

  local base candidates p
  if [ -n "$PORT" ]; then
    candidates="$PORT"
  else
    base=$((22400 + ${TERMIHUB_TEST_PORT_OFFSET:-0}))
    candidates="$(seq "$base" $((base + 49)))"
  fi
  for p in $candidates; do
    port_in_use "$p" && continue
    PORT="$p"
    write_config
    if start_sshd; then
      echo "$PORT" >"$PORT_FILE"
      if [ -n "$AGENT_BIN" ]; then
        [ -x "$AGENT_BIN" ] || die "--agent-binary $AGENT_BIN is not an executable file"
        (cd "$(dirname "$AGENT_BIN")" && echo "$PWD/$(basename "$AGENT_BIN")") >"$AGENT_BIN_FILE"
      fi
      log "sshd listening on 127.0.0.1:$PORT (pid $(recorded_sshd_pid), state $STATE_DIR)"
      self_test
      emit_env
      return 0
    fi
    log "sshd failed on port $p; trying the next one"
    stop_sshd
  done
  [ -f "$LOG_FILE" ] && sed 's/^/  | /' "$LOG_FILE" >&2
  die "could not start sshd on any candidate port"
}

require_state() {
  [ -f "$CONFIG" ] && [ -f "$PORT_FILE" ] || die "no fixture state in $STATE_DIR (run 'up' first)"
  PORT="$(cat "$PORT_FILE")"
}

cmd_down() {
  stop_sshd
  case "$STATE_DIR" in
    "" | / | "$HOME") die "refusing to delete state dir '$STATE_DIR'" ;;
  esac
  rm -rf "$STATE_DIR"
  log "fixture torn down ($STATE_DIR removed)"
}

case "$ACTION" in
  up) cmd_up ;;
  start)
    require_state
    start_sshd || die "sshd did not come back on 127.0.0.1:$PORT (log: $LOG_FILE)"
    log "sshd restarted on 127.0.0.1:$PORT"
    ;;
  stop)
    require_state
    stop_sshd
    log "sshd stopped (state kept in $STATE_DIR)"
    ;;
  env)
    require_state
    emit_env
    ;;
  down) cmd_down ;;
  *)
    echo "error: unknown action: $ACTION" >&2
    usage >&2
    exit 2
    ;;
esac
