#!/usr/bin/env bash
#
# Run the live Windows SSH-host agent tests for one OpenSSH DefaultShell (#3684).
#
# 1. Desktop -> Windows host: deploys + installs the agent to a real
#    Win32-OpenSSH host through a cmd.exe or PowerShell DefaultShell
#    (MT-AGENT-18/19), connects to it over SSH exec `--stdio` (MT-AGENT-20) and
#    re-attaches a named-pipe daemon session after a disconnect (MT-AGENT-24) --
#    src-tauri/src/terminal/agent_manager/windows_ssh_host_tests.rs.
# 2. Windows agent -> targets: an SSH session opened through a Windows-hosted
#    agent (MT-AGENT-26), with the default key and with the Windows ssh-agent
#    service (MT-AGENT-27), and the Docker engine over its named pipe
#    (MT-AGENT-28) -- agent/tests/native_sshd_agent_backends.rs.
#
# Steps: build the agent, set HKLM\SOFTWARE\OpenSSH\DefaultShell, bring up the
# native sshd fixture (native-sshd-fixture.sh, which hands over to its
# PowerShell twin on Windows), run exactly that shell's desktop test, then
# start the ssh-agent service with the fixture key and probe the Docker engine
# and run the agent-side suite, all with TERMIHUB_REQUIRE_WINDOWS_SSH=1; fail
# if any expected test skipped or did not run. On exit the sshd log is printed
# (on failure), the key is removed from the ssh-agent and the service restored,
# the fixture is torn down and the previous DefaultShell is restored.
#
# Windows only (Git Bash in an elevated shell, as on the GitHub windows runner):
# the DefaultShell is a Windows OpenSSH setting. The `Windows SSH Host` workflow
# (.github/workflows/windows-ssh-host.yml) runs it once per shell; the recipe
# lives here so a scheduled run (main's copy of the workflow) runs develop's.
#
# Usage:
#   scripts/internal/run-windows-ssh-host-suite.sh <cmd|powershell> [extra cargo test args...]

set -euo pipefail

usage() {
  sed -n '3,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

case "${1:-}" in
  -h | --help)
    usage
    exit 0
    ;;
  cmd | powershell)
    DEFAULT_SHELL="$1"
    shift
    ;;
  *)
    usage >&2
    echo "error: expected the DefaultShell to test: cmd or powershell (got '${1:-}')" >&2
    exit 2
    ;;
esac

case "$(uname -s)" in
  MINGW* | MSYS* | CYGWIN*) ;;
  *)
    echo "error: the Windows SSH-host suite needs a Windows host (Git Bash, elevated);" \
      "this is $(uname -s). Off Windows the tests skip under plain cargo test." >&2
    exit 2
    ;;
esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
FIXTURE="$SCRIPT_DIR/native-sshd-fixture.sh"
TEST_NAME="terminal::agent_manager::windows_ssh_host_tests::${DEFAULT_SHELL}_default_shell_deploy_install_connect_reattach"
AGENT_SUITE="native_sshd_agent_backends"
AGENT_TESTS=(
  ssh_session_through_agent_round_trips_resizes_and_closes_cleanly
  ssh_session_through_agent_authenticates_with_the_default_key
  ssh_session_through_agent_authenticates_with_the_ssh_agent
)
DOCKER_TEST="docker_engine_is_reached_over_its_named_pipe"
OPENSSH_KEY='HKLM:\SOFTWARE\OpenSSH'
cd "$REPO_ROOT"

# Run one PowerShell command (Git Bash would mangle reg.exe's `/x` switches).
# A failure prints PowerShell's own error to stderr and exits 1; success always
# exits 0 -- `pwsh -Command` otherwise exits 1 whenever the last statement set
# `$?` to false, even for an error it was told to ignore (a silent failure).
run_pwsh() {
  pwsh -NoProfile -NonInteractive -Command "\$ErrorActionPreference = 'Stop'
    try { $1 } catch {
      [Console]::Error.WriteLine(\"pwsh: \$(\$_.Exception.Message)\")
      exit 1
    }
    exit 0"
}

set_default_shell() {
  # $1: `powershell`, `cmd` / empty (OpenSSH's default, cmd.exe), or an
  # executable path (the value being restored).
  local value
  case "$1" in
    "" | cmd)
      # Remove only a value that exists: removing an absent one is an error.
      run_pwsh "if ((Test-Path '$OPENSSH_KEY') -and
          (Get-ItemProperty -Path '$OPENSSH_KEY').PSObject.Properties['DefaultShell']) {
        Remove-ItemProperty -Path '$OPENSSH_KEY' -Name DefaultShell
      }"
      return
      ;;
    powershell) value="(Join-Path \$env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe')" ;;
    *) value="'$1'" ;;
  esac
  run_pwsh "New-Item -Path '$OPENSSH_KEY' -Force | Out-Null
    New-ItemProperty -Path '$OPENSSH_KEY' -Name DefaultShell -Value $value -PropertyType String -Force | Out-Null"
}

show_default_shell() {
  run_pwsh "if (Test-Path '$OPENSSH_KEY') {
    (Get-ItemProperty -Path '$OPENSSH_KEY').PSObject.Properties['DefaultShell'].Value
  }"
}

# Print the end of the fixture's sshd log. sshd holds it open while running
# (Git Bash's `tail` then fails with "Device or resource busy"), so stop the
# listener first; if the file is still locked, read it through .NET with full
# sharing.
print_sshd_log() {
  local log_win="$TERMIHUB_NATIVE_SSHD_DIR\\sshd.log"
  local log
  log="$(cygpath -u "$log_win")"
  "$FIXTURE" stop >/dev/null 2>&1 || echo "warning: could not stop the native sshd before reading its log" >&2
  [ -f "$log" ] || {
    echo "---- no native sshd log at $log ----" >&2
    return 0
  }
  echo "---- native sshd log (last 200 lines) ----" >&2
  if ! tail -n 200 "$log" >&2 2>/dev/null; then
    run_pwsh "\$fs = [System.IO.File]::Open('$log_win', 'Open', 'Read', 'ReadWrite, Delete')
      try { \$text = (New-Object System.IO.StreamReader(\$fs)).ReadToEnd() } finally { \$fs.Dispose() }
      \$text -split '\r?\n' | Select-Object -Last 200" >&2 ||
      echo "warning: could not read the native sshd log" >&2
  fi
}

# The Windows ssh-agent service, holding the fixture client key for the
# agent-auth test (MT-AGENT-27). The service ships disabled on the runner;
# its previous start type is restored on teardown.
SSH_AGENT_PREVIOUS_START=""
start_ssh_agent_with_fixture_key() {
  SSH_AGENT_PREVIOUS_START="$(run_pwsh "(Get-Service ssh-agent).StartType.ToString()")" ||
    return 1
  # pwsh ends its output lines with CRLF; keep only the value.
  SSH_AGENT_PREVIOUS_START="${SSH_AGENT_PREVIOUS_START//[$'\r\n']/}"
  run_pwsh "Set-Service -Name ssh-agent -StartupType Manual
    Start-Service ssh-agent
    \$add = Join-Path \$env:SystemRoot 'System32\\OpenSSH\\ssh-add.exe'
    & \$add \$env:TERMIHUB_NATIVE_SSHD_KEY
    if (\$LASTEXITCODE -ne 0) { throw \"ssh-add exited \$LASTEXITCODE\" }"
}

stop_ssh_agent() {
  [ -n "$SSH_AGENT_PREVIOUS_START" ] || return 0
  run_pwsh "\$add = Join-Path \$env:SystemRoot 'System32\\OpenSSH\\ssh-add.exe'
    & \$add -D 2>\$null
    Stop-Service ssh-agent -ErrorAction SilentlyContinue
    Set-Service -Name ssh-agent -StartupType '$SSH_AGENT_PREVIOUS_START'"
}

# Whether the runner's Docker engine answers (best effort: start the service
# first if it is installed but stopped).
docker_engine_up() {
  command -v docker >/dev/null 2>&1 || return 1
  run_pwsh "if (Get-Service docker -ErrorAction SilentlyContinue) {
      Start-Service docker -ErrorAction SilentlyContinue
    }" >/dev/null 2>&1 || true
  docker version --format '{{.Server.Os}}' >/dev/null 2>&1
}

# Fail unless every named test of the suite in log $1 passed and none skipped.
require_passed() {
  local log="$1" name
  shift
  for name in "$@"; do
    if ! grep -q "test $name ... ok" "$log"; then
      echo "::error::$name did not run and pass"
      exit 1
    fi
  done
  if grep -q 'SKIPPED:' "$log"; then
    echo "::error::a test skipped in the Windows SSH-host lane:"
    grep 'SKIPPED:' "$log"
    exit 1
  fi
}

teardown() {
  local rc=$?
  if [ "$rc" -ne 0 ] && [ -n "${TERMIHUB_NATIVE_SSHD_DIR:-}" ]; then
    print_sshd_log || true
  fi
  stop_ssh_agent || echo "warning: could not restore the ssh-agent service" >&2
  "$FIXTURE" down || echo "warning: native sshd teardown failed" >&2
  set_default_shell "$PREVIOUS_SHELL" ||
    echo "warning: could not restore the DefaultShell (was '${PREVIOUS_SHELL:-<unset>}')" >&2
  exit "$rc"
}

# Each setup step names its failure: under `set -e` a bare failure would only
# show up as the teardown's lines and an exit code.
die() {
  echo "::error::$*" >&2
  exit 1
}

PREVIOUS_SHELL="$(show_default_shell)" || die "could not read the OpenSSH DefaultShell (HKLM)"
# The deployed agent links the VC runtime statically, like the released one
# (#4175, release.yml / build-agents.*). The explicit --target keeps those
# RUSTFLAGS off build scripts and proc macros and gives the build its own
# target dir, so the `cargo test` builds below stay dynamic and are not rebuilt.
HOST_TRIPLE="$(rustc -vV | awk '/^host:/ { print $2 }')"
[ -n "$HOST_TRIPLE" ] || die "could not determine the Rust host triple"
RUSTFLAGS="${RUSTFLAGS:+$RUSTFLAGS }-C target-feature=+crt-static" \
  cargo build --target "$HOST_TRIPLE" -p termihub-agent || die "could not build termihub-agent"
AGENT_BIN="${CARGO_TARGET_DIR:-$REPO_ROOT/target}/$HOST_TRIPLE/debug/termihub-agent.exe"
[ -f "$AGENT_BIN" ] || die "built agent not found at $AGENT_BIN"

# Armed before `up`, so a half-started fixture is torn down too.
trap teardown EXIT
set_default_shell "$DEFAULT_SHELL" || die "could not set the OpenSSH DefaultShell to $DEFAULT_SHELL"
current_shell="$(show_default_shell)" || die "could not read back the OpenSSH DefaultShell"
echo "OpenSSH DefaultShell: ${current_shell:-<unset> (cmd.exe)}"

exports="$("$FIXTURE" up --agent-binary "$AGENT_BIN")" ||
  die "native sshd fixture failed to come up (its log is above)"
eval "$exports"

export TERMIHUB_WINDOWS_SSH_DEFAULT_SHELL="$DEFAULT_SHELL"
export TERMIHUB_REQUIRE_WINDOWS_SSH=1
log="$(mktemp)"
# --show-output (not --nocapture): the test's own lines print after it ends, so
# libtest's "test <name> ... ok" line stays contiguous for the check below.
cargo test -p termihub --lib "$TEST_NAME" -- --exact --show-output "$@" 2>&1 | tee "$log"
# Guard against a false green: the named test must have run and passed, and
# must not have skipped.
require_passed "$log" "$TEST_NAME"

# ---- Windows agent -> targets (MT-AGENT-26/27/28) ----
start_ssh_agent_with_fixture_key ||
  die "could not start the ssh-agent service with the fixture key"
export TERMIHUB_WINDOWS_SSH_AGENT=1
agent_tests=("${AGENT_TESTS[@]}")
skip_args=()
if docker_engine_up; then
  export TERMIHUB_WINDOWS_DOCKER=1
  agent_tests+=("$DOCKER_TEST")
else
  # Not every runner image ships a running engine; say so instead of failing.
  echo "::warning::no Docker engine answers on this runner; skipping $DOCKER_TEST (MT-AGENT-28)"
  skip_args=(--skip "$DOCKER_TEST")
fi
agent_log="$(mktemp)"
cargo test -p termihub-agent --test "$AGENT_SUITE" -- --test-threads=1 --show-output \
  ${skip_args[@]+"${skip_args[@]}"} "$@" 2>&1 | tee "$agent_log"
require_passed "$agent_log" "${agent_tests[@]}"
