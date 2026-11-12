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
#                                                 [--default-shell cmd|powershell|bash]
#   scripts/internal/native-sshd-fixture.sh stop  [--dir DIR]   # listener down, state kept
#   scripts/internal/native-sshd-fixture.sh start [--dir DIR]   # restart after stop
#   scripts/internal/native-sshd-fixture.sh jump-stop  [--dir DIR]  # bastion down only
#   scripts/internal/native-sshd-fixture.sh jump-start [--dir DIR]  # bastion back up
#   scripts/internal/native-sshd-fixture.sh env   [--dir DIR] [--github-env]
#   scripts/internal/native-sshd-fixture.sh down  [--dir DIR]   # stop + delete all state
#   scripts/internal/native-sshd-fixture.sh variant-up  --variant NAME [--port N]
#                                     [--setenv KEY=VALUE]... [--kbdint] [--dir DIR]
#                                     [--banner] [--sftp-only]
#                                     [--sudoer | --second-user] [--elevated-target]
#   scripts/internal/native-sshd-fixture.sh variant-log --variant NAME [--dir DIR]
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
# `--jump-host` (#5176; Windows since #5422) starts a second sshd on the next
# free port with the same users and keys: the bastion of the jump-host suite,
# which forwards to the first sshd. `jump-stop` / `jump-start` drop and restore
# only the bastion, so the suite can sever every session that rides it.
#
# `--default-shell` (#5422, Windows only) sets Win32-OpenSSH's DefaultShell
# for the fixture's lifetime (`bash` = Git Bash, so the suites that type POSIX
# commands run there); `down` restores the previous value.
#
# `variant-up` (#5444, macOS/Linux) starts, or restarts with a fresh config,
# one more sshd on --port for the same login user: an agent "host" of its own.
# Its sessions get their own HOME and XDG dirs (the variant home), a private
# agent registry endpoint, and every --setenv pair, through sshd `SetEnv`. The
# armed and real-swap deployed-agent suites use it to give the agents they
# start the test-hook env without it ever reaching the plain agent suites.
# `--kbdint` makes it keyboard-interactive only (PAM), which needs the root
# sshd of a --password-login fixture, so it is CI-only like that flag. The
# variant home lives in the state dir, or in the dedicated user's home for a
# --password-login fixture. It prints the variant home as its last line.
# `variant-log` prints that sshd's log; `down` stops every variant too.
#
# Fixture-specific hosts (#5423) are variants too, for the editor-permission,
# banner and SFTP-only suites:
#   --banner           a pre-auth `Banner`, plus a MOTD line the variant home's
#                      .zshrc prints at login
#   --sftp-only        `ForceCommand internal-sftp`: no shell, SFTP only
#   --sudoer           a sudoers drop-in (/etc/sudoers.d/termihub-native-sshd)
#                      that lets the login user run anything as root WITH its
#                      password; checked with `visudo -c` before and after
#   --second-user      log in as a second dedicated user, `termihubnosudo`
#                      (same password and keys, no sudo rule)
#   --elevated-target  a root-owned /etc/termihub-elevated-target.txt (mode 644)
# The last three change system config, so like --password-login they need its
# root fixture, run only on CI (or with TERMIHUB_NATIVE_SSHD_ALLOW_SYSTEM_USER=1)
# and refuse anywhere else. `down` removes the drop-in, the file and the user.
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
  # The header comment, up to its first non-comment line.
  awk 'NR < 3 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "${BASH_SOURCE[0]}"
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
DEFAULT_SHELL=""
VARIANT=""
KBDINT=0
SETENV=()
BANNER=0
SFTP_ONLY=0
SUDOER=0
SECOND_USER_LOGIN=0
ELEVATED=0
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
    --default-shell)
      DEFAULT_SHELL="${2:?--default-shell needs cmd, powershell or bash}"
      shift 2
      ;;
    --variant)
      VARIANT="${2:?--variant needs a value}"
      shift 2
      ;;
    --setenv)
      SETENV+=("${2:?--setenv needs KEY=VALUE}")
      shift 2
      ;;
    --kbdint)
      KBDINT=1
      shift
      ;;
    --banner)
      BANNER=1
      shift
      ;;
    --sftp-only)
      SFTP_ONLY=1
      shift
      ;;
    --sudoer)
      SUDOER=1
      shift
      ;;
    --second-user)
      SECOND_USER_LOGIN=1
      shift
      ;;
    --elevated-target)
      ELEVATED=1
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
    [ "$JUMP_HOST" -eq 0 ] || ps_args+=(-JumpHost)
    [ -z "$DEFAULT_SHELL" ] || ps_args+=(-DefaultShell "$DEFAULT_SHELL")
    exec pwsh -NoProfile -ExecutionPolicy Bypass -File "$(cygpath -w "$SCRIPT_DIR/native-sshd-fixture.ps1")" "${ps_args[@]}"
    ;;
esac

if [ -n "$DEFAULT_SHELL" ]; then
  echo "error: --default-shell is a Win32-OpenSSH setting (Windows only)" >&2
  exit 2
fi

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
# --second-user (#5423): a second dedicated user with no sudo rule, recorded the
# same way and only ever this fixed name.
SECOND_USER="termihubnosudo"
SECOND_USER_FILE="$STATE_DIR/second_user"
# --sudoer / --elevated-target (#5423): fixed system paths, recorded in the
# state dir when installed so `down` removes exactly these and nothing else.
SUDOERS_DROPIN="/etc/sudoers.d/termihub-native-sshd"
SUDOERS_STATE="$STATE_DIR/sudoers_dropin"
ELEVATED_TARGET="/etc/termihub-elevated-target.txt"
ELEVATED_STATE="$STATE_DIR/elevated_target"

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

# The guard every system change sits behind: it adds a local account, a sudo
# rule or a root-owned file, so only on a throwaway CI runner, unless asked for.
# $1 names the change in the refusal.
require_system_change_allowed() {
  if [ -z "${CI:-}" ] && [ "${TERMIHUB_NATIVE_SSHD_ALLOW_SYSTEM_USER:-}" != 1 ]; then
    die "$1; it runs only on CI" \
      "(or set TERMIHUB_NATIVE_SSHD_ALLOW_SYSTEM_USER=1 on a machine you can throw away)"
  fi
}

# --password-login on macOS: a dedicated local user with a random password and
# a fresh home that holds the fixture keys. Needs passwordless sudo.
create_system_user() {
  [ "$(uname -s)" = Darwin ] ||
    die "--password-login needs a dedicated user; only macOS and Windows support it"
  require_system_change_allowed "--password-login creates the local user $SYSTEM_USER"
  sudo -n true 2>/dev/null || die "--password-login needs passwordless sudo"
  if dscl . -read "/Users/$SYSTEM_USER" >/dev/null 2>&1; then
    die "local user $SYSTEM_USER already exists; remove it or run 'down' on its fixture"
  fi
  local password
  # Hex only: no shell, PAM or form-field quoting can mangle it.
  password="Tn$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')"
  # Recorded first, so a half-created user is still removed by `down`.
  echo "$SYSTEM_USER" >"$SYSTEM_USER_FILE"
  (umask 077 && echo "$password" >"$PASSWORD_FILE")
  create_local_user "$SYSTEM_USER" "$password"
}

# create_local_user NAME PASSWORD: a macOS local user with a fresh home holding
# the fixture's authorized_keys. The caller records NAME in the state dir first.
create_local_user() {
  local user="$1" password="$2" uid home="/Users/$1"
  uid="$(dscl . -list /Users UniqueID | awk '$2 >= 600 && $2 < 1000 { print $2 }' | sort -n | tail -1)"
  uid=$((${uid:-600} + 1))
  sudo -n dscl . -create "/Users/$user"
  sudo -n dscl . -create "/Users/$user" UserShell /bin/zsh
  sudo -n dscl . -create "/Users/$user" RealName "termiHub native sshd fixture"
  sudo -n dscl . -create "/Users/$user" UniqueID "$uid"
  sudo -n dscl . -create "/Users/$user" PrimaryGroupID 20
  sudo -n dscl . -create "/Users/$user" NFSHomeDirectory "$home"
  sudo -n dscl . -passwd "/Users/$user" "$password"
  # Remote Login restricted to a group: let the fixture user in.
  if dscl . -read /Groups/com.apple.access_ssh >/dev/null 2>&1; then
    sudo -n dseditgroup -o edit -a "$user" -t user com.apple.access_ssh
  fi
  sudo -n mkdir -p "$home/.ssh"
  sudo -n cp "$AUTH_KEYS" "$home/.ssh/authorized_keys"
  # An empty .zshrc: a zsh login shell starts at a prompt, not zsh-newuser-install.
  echo "# native-sshd-fixture password-login home (#5176)" | sudo -n tee "$home/.zshrc" >/dev/null
  sudo -n chown -R "$user:staff" "$home"
  sudo -n chmod 700 "$home" "$home/.ssh"
  sudo -n chmod 600 "$home/.ssh/authorized_keys"
  log "local user $user (uid $uid) ready"
}

# delete_local_user STATE_FILE EXPECTED: the user recorded in STATE_FILE, which
# must be the fixed EXPECTED name, and its home. A no-op when none is recorded.
delete_local_user() {
  local state_file="$1" expected="$2" user
  [ -s "$state_file" ] || return 0
  user="$(cat "$state_file")"
  # Only ever the fixture's own fixed account.
  [ "$user" = "$expected" ] || die "refusing to delete unexpected user '$user'"
  # Whatever a test session left running as the fixture user.
  sudo -n pkill -KILL -U "$user" 2>/dev/null || true
  if dscl . -read "/Users/$user" >/dev/null 2>&1; then
    sudo -n dscl . -delete "/Users/$user" || log "could not delete local user $user"
  fi
  sudo -n rm -rf "/Users/$user"
  rm -f "$state_file"
  log "local user $user removed"
}

delete_system_user() {
  delete_local_user "$SECOND_USER_FILE" "$SECOND_USER"
  delete_local_user "$SYSTEM_USER_FILE" "$SYSTEM_USER"
}

# ── System changes of the fixture-specific hosts (#5423) ──────────────────────
# Each one is CI-only (require_system_change_allowed) and needs the root sshd
# of a --password-login fixture, whose passwordless sudo it uses.
require_system_change() {
  require_system_change_allowed "$1 changes the system configuration"
  [ "${#SUDO[@]}" -gt 0 ] || die "$1 needs a --password-login fixture (a root sshd); CI only"
  [ "$(uname -s)" = Darwin ] || die "$1 is only supported on macOS"
  sudo -n true 2>/dev/null || die "$1 needs passwordless sudo"
}

# The second, no-sudo login user: same password and keys as the first.
ensure_second_user() {
  if [ -s "$SECOND_USER_FILE" ] && dscl . -read "/Users/$SECOND_USER" >/dev/null 2>&1; then
    return 0
  fi
  if dscl . -read "/Users/$SECOND_USER" >/dev/null 2>&1; then
    die "local user $SECOND_USER already exists; remove it or run 'down' on its fixture"
  fi
  # Recorded first, so a half-created user is still removed by `down`.
  echo "$SECOND_USER" >"$SECOND_USER_FILE"
  create_local_user "$SECOND_USER" "$(cat "$PASSWORD_FILE")"
}

# A sudoers drop-in scoped to the login user: everything as root, password
# required (no NOPASSWD), no lecture. `visudo -c` checks the new file before it
# goes in and the whole policy after; a policy that fails is rolled back.
install_sudoers() {
  local user="$1" tmp="$STATE_DIR/sudoers.$$"
  case "$user" in
    "$SYSTEM_USER") ;;
    *) die "refusing a sudo rule for '$user': only $SYSTEM_USER gets one" ;;
  esac
  {
    echo "# termiHub native sshd fixture (#5423): CI-only, removed by its 'down'."
    echo "Defaults:$user !lecture"
    echo "$user ALL=(ALL) ALL"
  } >"$tmp"
  sudo -n visudo -c -q -f "$tmp" || {
    rm -f "$tmp"
    die "visudo rejects the fixture's sudoers drop-in"
  }
  echo "$SUDOERS_DROPIN" >"$SUDOERS_STATE"
  sudo -n mkdir -p "$(dirname "$SUDOERS_DROPIN")"
  sudo -n install -m 0440 -o root -g wheel "$tmp" "$SUDOERS_DROPIN"
  rm -f "$tmp"
  if ! sudo -n visudo -c -q; then
    sudo -n rm -f "$SUDOERS_DROPIN"
    die "the sudoers policy fails 'visudo -c' with the drop-in; removed it again"
  fi
  # The rule must really be in effect (sudoers.d is included by the policy).
  local rules
  rules="$(sudo -n sudo -l -U "$user" 2>/dev/null || true)"
  case "$rules" in
    *"(ALL) ALL"*) ;;
    *) die "sudo does not list the drop-in's rule for $user ($SUDOERS_DROPIN)" ;;
  esac
  log "sudoers drop-in $SUDOERS_DROPIN lets $user use sudo (password required)"
}

remove_sudoers() {
  [ -s "$SUDOERS_STATE" ] || return 0
  [ "$(cat "$SUDOERS_STATE")" = "$SUDOERS_DROPIN" ] ||
    die "refusing to remove unexpected sudoers file '$(cat "$SUDOERS_STATE")'"
  sudo -n rm -f "$SUDOERS_DROPIN"
  rm -f "$SUDOERS_STATE"
  log "sudoers drop-in $SUDOERS_DROPIN removed"
}

# The root-owned file the editor-permission suites open read-only and save
# with sudo; known contents, like the ssh-sudo image's. Written to a temp name
# and renamed, so two variants bringing it up at once never see a torn file.
install_elevated_target() {
  local tmp="$ELEVATED_TARGET.termihub.$$"
  echo "$ELEVATED_TARGET" >"$ELEVATED_STATE"
  printf 'original-root-owned-content\n' | sudo -n tee "$tmp" >/dev/null
  sudo -n chown root:wheel "$tmp"
  sudo -n chmod 644 "$tmp"
  sudo -n mv -f "$tmp" "$ELEVATED_TARGET"
}

remove_elevated_target() {
  [ -s "$ELEVATED_STATE" ] || return 0
  [ "$(cat "$ELEVATED_STATE")" = "$ELEVATED_TARGET" ] ||
    die "refusing to remove unexpected file '$(cat "$ELEVATED_STATE")'"
  sudo -n rm -f "$ELEVATED_TARGET"
  rm -f "$ELEVATED_STATE"
  log "$ELEVATED_TARGET removed"
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

# ── Agent-host variants (#5444) ───────────────────────────────────────────────
VARIANTS_DIR="$STATE_DIR/variants"

variant_dir() {
  case "$VARIANT" in
    "" | *[!a-z0-9-]*) die "--variant needs a name of [a-z0-9-] (got '$VARIANT')" ;;
  esac
  echo "$VARIANTS_DIR/$VARIANT"
}

# The registry endpoint dir of a variant on PORT: short (a unix socket path is
# capped at 104 bytes on macOS) and keyed by our own port.
variant_registry_dir() { echo "/tmp/thub-nsv-$1"; }

cmd_variant_up() {
  # require_state loads the main sshd's port into PORT: keep the variant's.
  local want_port="$PORT"
  require_state
  load_mode
  local vdir home port lock i
  vdir="$(variant_dir)"
  if [ "$KBDINT" -eq 1 ] && [ "${#SUDO[@]}" -eq 0 ]; then
    die "--kbdint needs a --password-login fixture (a root sshd with PAM); CI only"
  fi
  # The system changes (#5423): refused before anything is touched.
  if [ "$SUDOER" -eq 1 ] && [ "$SECOND_USER_LOGIN" -eq 1 ]; then
    die "--sudoer and --second-user exclude each other: the second user has no sudo rule"
  fi
  [ "$SUDOER" -eq 0 ] || require_system_change "--sudoer"
  [ "$SECOND_USER_LOGIN" -eq 0 ] || require_system_change "--second-user"
  [ "$ELEVATED" -eq 0 ] || require_system_change "--elevated-target"
  mkdir -p "$VARIANTS_DIR"
  # One caller at a time: parallel test workers may bring the same variant up.
  lock="$vdir.lock"
  for i in $(seq 1 600); do
    mkdir "$lock" 2>/dev/null && break
    [ "$i" -eq 600 ] && die "timed out waiting for $lock"
    sleep 0.1
  done
  # shellcheck disable=SC2064 # expand $lock now: it is fixed for this run
  trap "rmdir '$lock' 2>/dev/null || true" EXIT
  mkdir -p "$vdir"
  if [ -s "$vdir/port" ]; then
    port="$(cat "$vdir/port")"
    [ -z "$want_port" ] || [ "$want_port" = "$port" ] ||
      die "variant $VARIANT already runs on port $port, not $want_port"
  else
    port="${want_port:?variant-up of a new variant needs --port}"
  fi
  stop_sshd "$vdir/sshd.pid" "$vdir/sshd_config"
  # Our own variant is down now: anything still listening is someone else.
  if port_in_use "$port"; then
    die "variant $VARIANT: port $port is already taken"
  fi
  if [ "$SECOND_USER_LOGIN" -eq 1 ]; then
    ensure_second_user
    LOGIN_USER="$SECOND_USER"
  fi
  [ "$SUDOER" -eq 0 ] || install_sudoers "$LOGIN_USER"
  [ "$ELEVATED" -eq 0 ] || install_elevated_target
  # The variant home's .zshrc; a --banner host also prints a MOTD at login.
  local zshrc="# native-sshd-fixture variant home (#5444)"
  if [ "$BANNER" -eq 1 ]; then
    zshrc="$zshrc"$'\n'"echo 'Welcome to the termiHub native sshd fixture (MOTD, #5423)'"
  fi
  if [ "${#SUDO[@]}" -gt 0 ]; then
    # The dedicated user cannot enter the runner-owned state dir: its home.
    home="/Users/$LOGIN_USER/variants/$VARIANT"
    sudo -n mkdir -p "$home"
    sudo -n chown "$LOGIN_USER:staff" "/Users/$LOGIN_USER/variants" "$home"
    sudo -n chmod 700 "$home"
    printf '%s\n' "$zshrc" | sudo -n -u "$LOGIN_USER" tee "$home/.zshrc" >/dev/null
  else
    home="$vdir/home"
    mkdir -p "$home"
    chmod 700 "$home"
    printf '%s\n' "$zshrc" >"$home/.zshrc"
  fi
  local config="$vdir/sshd_config"
  write_config "$port" "$config" "$vdir/sshd.pid"
  if [ "$KBDINT" -eq 1 ]; then
    # sshd takes the first value of a keyword: these go before the base config.
    {
      printf '%s\n' 'KbdInteractiveAuthentication yes' 'PasswordAuthentication no' \
        'PubkeyAuthentication no' 'AuthenticationMethods keyboard-interactive' 'UsePAM yes'
      grep -v -E '^(KbdInteractiveAuthentication|PasswordAuthentication|PubkeyAuthentication|UsePAM) ' "$config"
    } >"$config.tmp"
    mv "$config.tmp" "$config"
  fi
  # The variant's own HOME / XDG dirs and registry, then the caller's pairs (a
  # caller's KEY replaces the default one).
  local -a env=(
    "HOME=$home" "XDG_CONFIG_HOME=$home/.config" "XDG_DATA_HOME=$home/.local/share"
    "XDG_STATE_HOME=$home/.local/state" "XDG_CACHE_HOME=$home/.cache" "HISTFILE=$home/.history"
    "TERMIHUB_REGISTRY_ENDPOINT=$(variant_registry_dir "$port")/registry"
    "TERMIHUB_REGISTRY_IDLE_TIMEOUT_SECS=15" "TERMIHUB_DAEMON_DETACHED_TIMEOUT_SECS=120"
  )
  local pair key line="SetEnv" kept
  for pair in "${env[@]}"; do
    key="${pair%%=*}"
    kept=1
    for kv in ${SETENV[@]+"${SETENV[@]}"}; do
      [ "${kv%%=*}" = "$key" ] && kept=0
    done
    [ "$kept" -eq 0 ] || line="$line \"$pair\""
  done
  for kv in ${SETENV[@]+"${SETENV[@]}"}; do
    case "$kv" in
      *=*) ;;
      *) die "--setenv needs KEY=VALUE (got '$kv')" ;;
    esac
    case "$kv" in
      *\"* | *\\*) die "--setenv value may not hold quotes or backslashes: '$kv'" ;;
    esac
    line="$line \"$kv\""
  done
  echo "$line" >>"$config"
  if [ "$BANNER" -eq 1 ]; then
    # The pre-auth banner, as the ssh-banner image shows it.
    printf '%s\n' "========================================================" \
      "  AUTHORIZED ACCESS ONLY - TEST SYSTEM" \
      "  This is a termiHub test server (native sshd fixture, #5423)." \
      "========================================================" >"$vdir/banner.txt"
    chmod 644 "$vdir/banner.txt"
    echo "Banner \"$vdir/banner.txt\"" >>"$config"
  fi
  if [ "$SFTP_ONLY" -eq 1 ]; then
    # Every session is the SFTP server: a shell or exec request is refused
    # ("This service allows sftp connections only."), as on ssh-sftp-only.
    echo "ForceCommand internal-sftp" >>"$config"
  fi
  local sshd
  sshd="$(find_sshd)" || die "no sshd binary found"
  ${SUDO[@]+"${SUDO[@]}"} "$sshd" -t -f "$config" ||
    die "variant $VARIANT: sshd rejects its config $config"
  { start_sshd "$config" "$vdir/sshd.pid" "$vdir/sshd.log" "$port" &&
    recorded_sshd_pid "$vdir/sshd.pid" "$config" >/dev/null; } || {
    [ -f "$vdir/sshd.log" ] && ${SUDO[@]+"${SUDO[@]}"} sed 's/^/  | /' "$vdir/sshd.log" >&2
    die "variant $VARIANT did not start on 127.0.0.1:$port"
  }
  echo "$port" >"$vdir/port"
  echo "$home" >"$vdir/home_path"
  log "variant $VARIANT sshd listening on 127.0.0.1:$port (home $home)"
  echo "$home"
}

cmd_variant_log() {
  require_state
  load_mode
  local vdir
  vdir="$(variant_dir)"
  [ -f "$vdir/sshd.log" ] || die "variant $VARIANT has no log (run variant-up first)"
  ${SUDO[@]+"${SUDO[@]}"} cat "$vdir/sshd.log"
}

stop_variants() {
  local vdir port
  [ -d "$VARIANTS_DIR" ] || return 0
  for vdir in "$VARIANTS_DIR"/*/; do
    [ -d "$vdir" ] || continue
    vdir="${vdir%/}"
    stop_sshd "$vdir/sshd.pid" "$vdir/sshd_config"
    if [ -s "$vdir/port" ]; then
      port="$(cat "$vdir/port")"
      ${SUDO[@]+"${SUDO[@]}"} rm -rf "$(variant_registry_dir "$port")" "$(variant_registry_dir "$port")"-*
    fi
  done
}

cmd_down() {
  load_mode
  stop_variants
  stop_sshd "$JUMP_PID_FILE" "$JUMP_CONFIG"
  stop_sshd "$PID_FILE" "$CONFIG"
  remove_sudoers
  remove_elevated_target
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
  variant-up) cmd_variant_up ;;
  variant-log) cmd_variant_log ;;
  *)
    echo "error: unknown action: $ACTION" >&2
    usage >&2
    exit 2
    ;;
esac
