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
#                                                 [--agent-binary PATH] [--scratch-home]
#                                                 [--password-login] [--jump-host]
#   scripts/internal/native-sshd-fixture.sh stop  [--dir DIR]   # listener down, state kept
#   scripts/internal/native-sshd-fixture.sh start [--dir DIR]   # restart after stop
#   scripts/internal/native-sshd-fixture.sh jump-stop  [--dir DIR]  # bastion down only
#   scripts/internal/native-sshd-fixture.sh jump-start [--dir DIR]  # bastion back up
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
#   TERMIHUB_NATIVE_SSHD_HOME        with --scratch-home (macOS/Linux): the
#                                    HOME every SSH session gets
#   TERMIHUB_NATIVE_SSHD_PASSWORD    with --password-login: the login user's
#                                    password (password auth is on)
#   TERMIHUB_NATIVE_SSHD_JUMP_PORT   with --jump-host: the bastion sshd's port
# `--github-env` also appends them to "$GITHUB_ENV" for later workflow steps.
#
# `--password-login` (#5176) turns on password auth for the system-test SSH
# suites. An unprivileged sshd cannot check a password, so on macOS it needs
# passwordless sudo (the hosted runner has it): it creates a dedicated local
# user `termihubssh` with a random password and runs sshd as root with PAM.
# That user's home is a fresh scratch home, so --scratch-home is not needed.
# `down` deletes the user and its home again. Never use it on a developer
# machine you care about: it adds a local account for the fixture's lifetime.
# On Windows the fixture's own test user gets password auth (-PasswordLogin).
#
# `--jump-host` (#5176, macOS/Linux) starts a second sshd on the next free port
# with the same users and keys: the bastion of the jump-host suite, which
# forwards to the first sshd. `jump-stop` / `jump-start` drop and restore only
# the bastion, so the suite can sever every session that rides it.
#
# `--scratch-home` (macOS/Linux; ignored on Windows, whose fixture logs in as
# its own dedicated user): sshd `SetEnv`s HOME, XDG_CONFIG/DATA/STATE/CACHE_HOME
# and HISTFILE into a `home` dir in the state dir, plus a private agent
# registry endpoint and a bounded detached-daemon lifetime. A deployed agent
# and its session daemons then never write into the login user's real home or
# share its agent registry (#5208). The login shell reads its dotfiles from,
# and writes its history to, that scratch home; it gets an empty .zshrc, so a
# zsh login shell starts at a prompt, not at zsh-newuser-install (#5296). The
# session's working directory stays the real home (sshd changes into the
# passwd home), so tests use absolute paths below TERMIHUB_NATIVE_SSHD_HOME.
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
  sed -n '3,85p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
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
SCRATCH_HOME=0
PASSWORD_LOGIN=0
JUMP_HOST=0
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
    --scratch-home)
      SCRATCH_HOME=1
      shift
      ;;
    --password-login)
      PASSWORD_LOGIN=1
      shift
      ;;
    --jump-host)
      JUMP_HOST=1
      shift
      ;;
    *)
      echo "error: unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

# Windows: the Win32-OpenSSH provisioning lives in the PowerShell twin.
# --scratch-home is not forwarded: that fixture's login user is a dedicated
# local test user, so its home is already a scratch home.
case "$(uname -s)" in
  MINGW* | MSYS* | CYGWIN*)
    ps_args=(-Action "$ACTION")
    [ -z "$STATE_DIR" ] || ps_args+=(-Dir "$(cygpath -w "$STATE_DIR")")
    [ -z "$PORT" ] || ps_args+=(-Port "$PORT")
    [ "$GITHUB_ENV_OUT" -eq 0 ] || ps_args+=(-GitHubEnv)
    [ -z "$AGENT_BIN" ] || ps_args+=(-AgentBinary "$(cygpath -w "$AGENT_BIN")")
    [ "$PASSWORD_LOGIN" -eq 0 ] || ps_args+=(-PasswordLogin)
    if [ "$JUMP_HOST" -eq 1 ]; then
      echo "error: --jump-host is not supported on Windows yet" >&2
      exit 2
    fi
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
SESSION_HOME="$STATE_DIR/home"
SESSION_HOME_FILE="$STATE_DIR/session_home"
# --jump-host: the bastion's own config, pid, log and port.
JUMP_CONFIG="$STATE_DIR/jump_sshd_config"
JUMP_PID_FILE="$STATE_DIR/jump_sshd.pid"
JUMP_LOG_FILE="$STATE_DIR/jump_sshd.log"
JUMP_PORT_FILE="$STATE_DIR/jump_port"
# --password-login: the dedicated login user and its password.
SYSTEM_USER_FILE="$STATE_DIR/system_user"
PASSWORD_FILE="$STATE_DIR/password"
ASKPASS="$STATE_DIR/askpass.sh"
# The dedicated password-login user (macOS). A fixed name, so `down` can only
# ever delete this one account.
SYSTEM_USER="termihubssh"

log() { echo "native-sshd: $*" >&2; }
die() {
  log "error: $*"
  exit 1
}

# The login user and the privilege the sshd runs with. Unprivileged by default;
# a --password-login fixture (recorded in the state dir) runs as root via sudo.
LOGIN_USER="$CURRENT_USER"
SUDO=()
load_mode() {
  if [ -s "$SYSTEM_USER_FILE" ]; then
    LOGIN_USER="$(cat "$SYSTEM_USER_FILE")"
    SUDO=(sudo -n)
  fi
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

# wait_listening PORT PID_FILE
wait_listening() {
  local port="$1" pid_file="$2" i
  for i in $(seq 1 100); do
    port_in_use "$port" && return 0
    # Give up early if sshd already died (bad config, port taken).
    if [ -f "$pid_file" ] && ! ps -p "$(tr -dc '0-9' <"$pid_file")" >/dev/null 2>&1; then
      return 1
    fi
    [ "$i" -eq 100 ] || sleep 0.1
  done
  return 1
}

# recorded_sshd_pid PID_FILE CONFIG: the PID recorded in the state dir, only if
# it still names OUR sshd: an sshd whose command line carries this fixture's
# config path (sshd's proctitle keeps it: "sshd: /usr/sbin/sshd -f <config> ...
# [listener]"). A recycled PID fails.
recorded_sshd_pid() {
  local pid_file="$1" config="$2" pid args
  [ -f "$pid_file" ] || return 1
  pid="$(tr -dc '0-9' <"$pid_file")"
  [ -n "$pid" ] || return 1
  args="$(ps -o args= -p "$pid" 2>/dev/null || true)"
  case "$args" in
    *sshd*" -f $config "* | *sshd*" -f $config") echo "$pid" ;;
    *) return 1 ;;
  esac
}

# write_config PORT CONFIG PID_FILE
write_config() {
  local port="$1" config="$2" pid_file="$3"
  local auth_keys="$AUTH_KEYS" password=no pam=no
  if [ "${#SUDO[@]}" -gt 0 ]; then
    # Root sshd: the per-user authorized_keys of the dedicated user (read as
    # that user, so it lives in its home), and passwords checked through PAM.
    auth_keys=".ssh/authorized_keys"
    password=yes
    pam=yes
  fi
  cat >"$config" <<EOF
# Generated by scripts/internal/native-sshd-fixture.sh -- test-only, loopback.
Port $port
ListenAddress 127.0.0.1
HostKey $HOST_KEY
PidFile $pid_file
AuthorizedKeysFile $auth_keys
PubkeyAuthentication yes
PasswordAuthentication $password
KbdInteractiveAuthentication no
UsePAM $pam
StrictModes no
AllowTcpForwarding yes
AllowUsers $LOGIN_USER
Subsystem sftp internal-sftp
LogLevel VERBOSE
# The suites open many sessions at once (key matrix, parallel tests); the
# default MaxStartups 10:30:100 randomly resets handshakes past 10.
MaxStartups 200:30:300
MaxSessions 100
EOF
  if [ "$SCRATCH_HOME" -eq 1 ] && [ "$config" = "$CONFIG" ]; then
    # Each token double-quoted: sshd splits SetEnv shell-style, and a state dir
    # may hold spaces. The detached timeout bounds how long a session daemon a
    # test leaves behind outlives it.
    local h="$SESSION_HOME"
    {
      printf 'SetEnv "HOME=%s" "XDG_CONFIG_HOME=%s" "XDG_DATA_HOME=%s"' \
        "$h" "$h/.config" "$h/.local/share"
      printf ' "XDG_STATE_HOME=%s" "XDG_CACHE_HOME=%s" "HISTFILE=%s"' \
        "$h/.local/state" "$h/.cache" "$h/.history"
      printf ' "TERMIHUB_REGISTRY_ENDPOINT=%s" TERMIHUB_REGISTRY_IDLE_TIMEOUT_SECS=15' \
        "$STATE_DIR/registry.sock"
      printf ' TERMIHUB_DAEMON_DETACHED_TIMEOUT_SECS=120\n'
    } >>"$config"
  fi
  # OpenSSH 9.8+ penalises a source address after failed auths
  # (PerSourcePenalties), and the rejection tests fail auth on purpose from
  # 127.0.0.1, which would then refuse the next test's connection. Older sshd
  # (Ubuntu 24.04 ships 9.6) rejects the unknown keyword, so keep the line only
  # where `sshd -t` accepts it.
  local sshd
  sshd="$(find_sshd)" || die "no sshd binary found (looked in /usr/sbin, /sbin, /usr/local/sbin, PATH)"
  echo "PerSourcePenalties no" >>"$config"
  if ! ${SUDO[@]+"${SUDO[@]}"} "$sshd" -t -f "$config" >/dev/null 2>&1; then
    grep -v '^PerSourcePenalties ' "$config" >"$config.tmp" && mv "$config.tmp" "$config"
  fi
}

# start_sshd CONFIG PID_FILE LOG_FILE PORT
start_sshd() {
  local config="$1" pid_file="$2" log_file="$3" port="$4" sshd
  sshd="$(find_sshd)" || die "no sshd binary found (looked in /usr/sbin, /sbin, /usr/local/sbin, PATH)"
  if recorded_sshd_pid "$pid_file" "$config" >/dev/null; then
    log "sshd already running (pid $(recorded_sshd_pid "$pid_file" "$config"))"
    return 0
  fi
  ${SUDO[@]+"${SUDO[@]}"} rm -f "$pid_file"
  # Without -D sshd daemonizes and writes PidFile; -E keeps its log with the state.
  ${SUDO[@]+"${SUDO[@]}"} "$sshd" -f "$config" -E "$log_file"
  wait_listening "$port" "$pid_file"
}

# stop_sshd PID_FILE CONFIG
stop_sshd() {
  local pid_file="$1" config="$2" pid children
  pid="$(recorded_sshd_pid "$pid_file" "$config")" || {
    ${SUDO[@]+"${SUDO[@]}"} rm -f "$pid_file"
    return 0
  }
  # The master's per-connection children (sshd-session / "sshd: user@..."),
  # collected before the master goes so an established session is severed too.
  children="$(pgrep -P "$pid" 2>/dev/null || true)"
  ${SUDO[@]+"${SUDO[@]}"} kill "$pid" 2>/dev/null || true
  local c comm
  for c in $children; do
    # Per-connection handlers: "sshd-session: user [priv]" / "sshd: user@...".
    comm="$(ps -o args= -p "$c" 2>/dev/null || true)"
    case "$comm" in
      sshd*) ${SUDO[@]+"${SUDO[@]}"} kill "$c" 2>/dev/null || true ;;
    esac
  done
  local i
  for i in $(seq 1 50); do
    ps -p "$pid" >/dev/null 2>&1 || break
    [ "$i" -eq 50 ] && ${SUDO[@]+"${SUDO[@]}"} kill -9 "$pid" 2>/dev/null || true
    sleep 0.1
  done
  ${SUDO[@]+"${SUDO[@]}"} rm -f "$pid_file"
}

# --password-login on macOS: a dedicated local user with a random password and
# a fresh home that holds the fixture keys. Needs passwordless sudo.
create_system_user() {
  [ "$(uname -s)" = Darwin ] ||
    die "--password-login needs a dedicated user; only macOS and Windows support it"
  # It adds a local account: only on a throwaway CI runner, unless asked for.
  if [ -z "${CI:-}" ] && [ "${TERMIHUB_NATIVE_SSHD_ALLOW_SYSTEM_USER:-}" != 1 ]; then
    die "--password-login creates the local user $SYSTEM_USER; it runs only on CI" \
      "(or set TERMIHUB_NATIVE_SSHD_ALLOW_SYSTEM_USER=1 on a machine you can throw away)"
  fi
  sudo -n true 2>/dev/null || die "--password-login needs passwordless sudo"
  if dscl . -read "/Users/$SYSTEM_USER" >/dev/null 2>&1; then
    die "local user $SYSTEM_USER already exists; remove it or run 'down' on its fixture"
  fi
  local uid home="/Users/$SYSTEM_USER" password
  uid="$(dscl . -list /Users UniqueID | awk '$2 >= 600 && $2 < 1000 { print $2 }' | sort -n | tail -1)"
  uid=$((${uid:-600} + 1))
  # Hex only: no shell, PAM or form-field quoting can mangle it.
  password="Tn$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')"
  # Recorded first, so a half-created user is still removed by `down`.
  echo "$SYSTEM_USER" >"$SYSTEM_USER_FILE"
  (umask 077 && echo "$password" >"$PASSWORD_FILE")
  sudo -n dscl . -create "/Users/$SYSTEM_USER"
  sudo -n dscl . -create "/Users/$SYSTEM_USER" UserShell /bin/zsh
  sudo -n dscl . -create "/Users/$SYSTEM_USER" RealName "termiHub native sshd fixture"
  sudo -n dscl . -create "/Users/$SYSTEM_USER" UniqueID "$uid"
  sudo -n dscl . -create "/Users/$SYSTEM_USER" PrimaryGroupID 20
  sudo -n dscl . -create "/Users/$SYSTEM_USER" NFSHomeDirectory "$home"
  sudo -n dscl . -passwd "/Users/$SYSTEM_USER" "$password"
  # Remote Login restricted to a group: let the fixture user in.
  if dscl . -read /Groups/com.apple.access_ssh >/dev/null 2>&1; then
    sudo -n dseditgroup -o edit -a "$SYSTEM_USER" -t user com.apple.access_ssh
  fi
  sudo -n mkdir -p "$home/.ssh"
  sudo -n cp "$AUTH_KEYS" "$home/.ssh/authorized_keys"
  # An empty .zshrc: a zsh login shell starts at a prompt, not zsh-newuser-install.
  echo "# native-sshd-fixture password-login home (#5176)" | sudo -n tee "$home/.zshrc" >/dev/null
  sudo -n chown -R "$SYSTEM_USER:staff" "$home"
  sudo -n chmod 700 "$home" "$home/.ssh"
  sudo -n chmod 600 "$home/.ssh/authorized_keys"
  log "local user $SYSTEM_USER (uid $uid) ready"
}

delete_system_user() {
  [ -s "$SYSTEM_USER_FILE" ] || return 0
  local user
  user="$(cat "$SYSTEM_USER_FILE")"
  # Only ever the fixture's own fixed account.
  [ "$user" = "$SYSTEM_USER" ] || die "refusing to delete unexpected user '$user'"
  # Whatever a test session left running as the fixture user.
  sudo -n pkill -KILL -U "$user" 2>/dev/null || true
  if dscl . -read "/Users/$user" >/dev/null 2>&1; then
    sudo -n dscl . -delete "/Users/$user" || log "could not delete local user $user"
  fi
  sudo -n rm -rf "/Users/$user"
  log "local user $user removed"
}

emit_env() {
  local lines
  lines="$(
    cat <<EOF
TERMIHUB_NATIVE_SSHD=1
TERMIHUB_NATIVE_SSHD_PORT=$(cat "$PORT_FILE")
TERMIHUB_NATIVE_SSHD_USER=$LOGIN_USER
TERMIHUB_NATIVE_SSHD_KEY=$CLIENT_KEY
TERMIHUB_NATIVE_SSHD_HOST_PUBKEY=$HOST_KEY.pub
TERMIHUB_NATIVE_SSHD_DIR=$STATE_DIR
EOF
  )"
  if [ -s "$AGENT_BIN_FILE" ]; then
    lines="$lines"$'\n'"TERMIHUB_NATIVE_SSHD_AGENT_BIN=$(cat "$AGENT_BIN_FILE")"
  fi
  if [ -s "$SESSION_HOME_FILE" ]; then
    lines="$lines"$'\n'"TERMIHUB_NATIVE_SSHD_HOME=$(cat "$SESSION_HOME_FILE")"
  fi
  if [ -s "$PASSWORD_FILE" ]; then
    lines="$lines"$'\n'"TERMIHUB_NATIVE_SSHD_PASSWORD=$(cat "$PASSWORD_FILE")"
  fi
  if [ -s "$JUMP_PORT_FILE" ]; then
    lines="$lines"$'\n'"TERMIHUB_NATIVE_SSHD_JUMP_PORT=$(cat "$JUMP_PORT_FILE")"
  fi
  if [ -s "$PASSWORD_FILE" ] && [ -n "${GITHUB_ACTIONS:-}" ]; then
    # A throwaway test password, but keep it out of the job log anyway: masked
    # before the export lines below print it.
    echo "::add-mask::$(cat "$PASSWORD_FILE")" >&2
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
# a command, and the sftp subsystem the SFTP suites need; with --password-login
# a password login too, and with --jump-host a login through the bastion.
self_test() {
  local opts=(-i "$CLIENT_KEY" -o BatchMode=yes -o IdentitiesOnly=yes
    -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR
    -o ConnectTimeout=10)
  local who
  who="$(ssh -p "$PORT" "${opts[@]}" "$LOGIN_USER@127.0.0.1" 'id -un')" ||
    die "ssh login to 127.0.0.1:$PORT failed (log: $LOG_FILE)"
  [ "$who" = "$LOGIN_USER" ] || die "ssh login ran as '$who', expected '$LOGIN_USER'"
  echo "pwd" | sftp -q -b - -P "$PORT" "${opts[@]}" "$LOGIN_USER@127.0.0.1" >/dev/null ||
    die "sftp subsystem on 127.0.0.1:$PORT failed (log: $LOG_FILE)"
  if [ -s "$PASSWORD_FILE" ]; then
    # SSH_ASKPASS_REQUIRE=force (OpenSSH 8.4+) answers the password prompt
    # without a TTY; publickey is off for this login, so only the password works.
    printf '#!/bin/sh\ncat %q\n' "$PASSWORD_FILE" >"$ASKPASS"
    chmod 700 "$ASKPASS"
    who="$(SSH_ASKPASS="$ASKPASS" SSH_ASKPASS_REQUIRE=force DISPLAY="${DISPLAY:-:0}" \
      ssh -p "$PORT" -o PreferredAuthentications=password -o PubkeyAuthentication=no \
      -o NumberOfPasswordPrompts=1 -o StrictHostKeyChecking=no \
      -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=10 \
      "$LOGIN_USER@127.0.0.1" 'id -un' </dev/null)" ||
      die "password login to 127.0.0.1:$PORT failed (log: $LOG_FILE)"
    [ "$who" = "$LOGIN_USER" ] || die "password login ran as '$who', expected '$LOGIN_USER'"
    rm -f "$ASKPASS"
  fi
  if [ -s "$JUMP_PORT_FILE" ]; then
    local jump
    jump="$(cat "$JUMP_PORT_FILE")"
    who="$(ssh -p "$PORT" "${opts[@]}" \
      -o ProxyCommand="ssh -p $jump -i $CLIENT_KEY -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -W %h:%p $LOGIN_USER@127.0.0.1" \
      "$LOGIN_USER@127.0.0.1" 'id -un')" ||
      die "ssh login through the bastion 127.0.0.1:$jump failed (log: $JUMP_LOG_FILE)"
    [ "$who" = "$LOGIN_USER" ] || die "jump login ran as '$who', expected '$LOGIN_USER'"
  fi
  log "self-test ok: ssh + sftp as $LOGIN_USER on 127.0.0.1:$PORT"
}

# The first free candidate port at or after $1 (empty = the default range).
pick_port() {
  local from="${1:-}" base p
  base=$((22400 + ${TERMIHUB_TEST_PORT_OFFSET:-0}))
  for p in $(seq "${from:-$base}" $((base + 49))); do
    port_in_use "$p" || {
      echo "$p"
      return 0
    }
  done
  return 1
}

cmd_up() {
  command -v ssh-keygen >/dev/null || die "ssh-keygen not found"
  if [ -d "$STATE_DIR" ]; then
    log "state dir exists; tearing down the previous fixture first"
    cmd_down
    LOGIN_USER="$CURRENT_USER"
    SUDO=()
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
  if [ "$PASSWORD_LOGIN" -eq 1 ]; then
    create_system_user
    load_mode
    if [ "$SCRATCH_HOME" -eq 1 ]; then
      log "--scratch-home ignored: the password-login user's home is already a scratch home"
      SCRATCH_HOME=0
    fi
  fi
  if [ "$SCRATCH_HOME" -eq 1 ]; then
    mkdir -p "$SESSION_HOME"
    chmod 700 "$SESSION_HOME"
    # A zsh login shell with no dotfiles in HOME starts the interactive
    # zsh-newuser-install menu instead of a prompt; an empty .zshrc skips it.
    echo "# native-sshd-fixture scratch home (#5296)" >"$SESSION_HOME/.zshrc"
    echo "$SESSION_HOME" >"$SESSION_HOME_FILE"
  fi

  local candidates p
  if [ -n "$PORT" ]; then
    candidates="$PORT"
  else
    candidates="$(seq $((22400 + ${TERMIHUB_TEST_PORT_OFFSET:-0})) $((22449 + ${TERMIHUB_TEST_PORT_OFFSET:-0})))"
  fi
  local started=0
  for p in $candidates; do
    port_in_use "$p" && continue
    PORT="$p"
    write_config "$PORT" "$CONFIG" "$PID_FILE"
    if start_sshd "$CONFIG" "$PID_FILE" "$LOG_FILE" "$PORT"; then
      started=1
      break
    fi
    log "sshd failed on port $p; trying the next one"
    stop_sshd "$PID_FILE" "$CONFIG"
  done
  if [ "$started" -eq 0 ]; then
    [ -f "$LOG_FILE" ] && ${SUDO[@]+"${SUDO[@]}"} sed 's/^/  | /' "$LOG_FILE" >&2
    die "could not start sshd on any candidate port"
  fi
  echo "$PORT" >"$PORT_FILE"
  if [ -n "$AGENT_BIN" ]; then
    [ -x "$AGENT_BIN" ] || die "--agent-binary $AGENT_BIN is not an executable file"
    (cd "$(dirname "$AGENT_BIN")" && echo "$PWD/$(basename "$AGENT_BIN")") >"$AGENT_BIN_FILE"
  fi
  log "sshd listening on 127.0.0.1:$PORT (pid $(recorded_sshd_pid "$PID_FILE" "$CONFIG"), state $STATE_DIR)"
  if [ "$JUMP_HOST" -eq 1 ]; then
    local jump
    jump="$(pick_port $((PORT + 1)))" || die "no free port for the jump-host bastion"
    write_config "$jump" "$JUMP_CONFIG" "$JUMP_PID_FILE"
    start_sshd "$JUMP_CONFIG" "$JUMP_PID_FILE" "$JUMP_LOG_FILE" "$jump" || {
      [ -f "$JUMP_LOG_FILE" ] && ${SUDO[@]+"${SUDO[@]}"} sed 's/^/  | /' "$JUMP_LOG_FILE" >&2
      die "could not start the jump-host bastion on 127.0.0.1:$jump"
    }
    echo "$jump" >"$JUMP_PORT_FILE"
    log "bastion sshd listening on 127.0.0.1:$jump"
  fi
  self_test
  emit_env
}

require_state() {
  [ -f "$CONFIG" ] && [ -f "$PORT_FILE" ] || die "no fixture state in $STATE_DIR (run 'up' first)"
  PORT="$(cat "$PORT_FILE")"
}

require_jump() {
  require_state
  [ -f "$JUMP_CONFIG" ] && [ -s "$JUMP_PORT_FILE" ] ||
    die "no jump-host bastion in $STATE_DIR (run 'up --jump-host' first)"
}

cmd_down() {
  load_mode
  stop_sshd "$JUMP_PID_FILE" "$JUMP_CONFIG"
  stop_sshd "$PID_FILE" "$CONFIG"
  delete_system_user
  case "$STATE_DIR" in
    "" | / | "$HOME") die "refusing to delete state dir '$STATE_DIR'" ;;
  esac
  # A root sshd leaves root-owned logs behind.
  ${SUDO[@]+"${SUDO[@]}"} rm -rf "$STATE_DIR"
  log "fixture torn down ($STATE_DIR removed)"
}

case "$ACTION" in
  up) cmd_up ;;
  start)
    require_state
    load_mode
    start_sshd "$CONFIG" "$PID_FILE" "$LOG_FILE" "$PORT" ||
      die "sshd did not come back on 127.0.0.1:$PORT (log: $LOG_FILE)"
    log "sshd restarted on 127.0.0.1:$PORT"
    ;;
  stop)
    require_state
    load_mode
    stop_sshd "$PID_FILE" "$CONFIG"
    log "sshd stopped (state kept in $STATE_DIR)"
    ;;
  jump-start)
    require_jump
    load_mode
    jump="$(cat "$JUMP_PORT_FILE")"
    start_sshd "$JUMP_CONFIG" "$JUMP_PID_FILE" "$JUMP_LOG_FILE" "$jump" ||
      die "the bastion did not come back on 127.0.0.1:$jump (log: $JUMP_LOG_FILE)"
    log "bastion sshd restarted on 127.0.0.1:$jump"
    ;;
  jump-stop)
    require_jump
    load_mode
    stop_sshd "$JUMP_PID_FILE" "$JUMP_CONFIG"
    log "bastion sshd stopped (state kept in $STATE_DIR)"
    ;;
  env)
    require_state
    load_mode
    emit_env
    ;;
  down) cmd_down ;;
  *)
    echo "error: unknown action: $ACTION" >&2
    usage >&2
    exit 2
    ;;
esac
