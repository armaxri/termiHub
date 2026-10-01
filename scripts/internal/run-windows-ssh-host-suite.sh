#!/usr/bin/env bash
#
# Run the live Windows SSH-host agent test for one OpenSSH DefaultShell (#3684).
#
# Deploys + installs the agent to a real Win32-OpenSSH host through a cmd.exe
# or PowerShell DefaultShell (MT-AGENT-18/19), connects to it over SSH exec
# `--stdio` (MT-AGENT-20) and re-attaches a named-pipe daemon session after a
# disconnect (MT-AGENT-24) -- the test in
# src-tauri/src/terminal/agent_manager/windows_ssh_host_tests.rs.
#
# Steps: build the agent, set HKLM\SOFTWARE\OpenSSH\DefaultShell, bring up the
# native sshd fixture (native-sshd-fixture.sh, which hands over to its
# PowerShell twin on Windows), run exactly that shell's test with
# TERMIHUB_REQUIRE_WINDOWS_SSH=1, and fail if it skipped or did not run. On exit
# the sshd log is printed (on failure), the fixture is torn down and the
# previous DefaultShell is restored.
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
  sed -n '3,24p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
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
OPENSSH_KEY='HKLM:\SOFTWARE\OpenSSH'
cd "$REPO_ROOT"

# Run one PowerShell command (Git Bash would mangle reg.exe's `/x` switches).
run_pwsh() {
  pwsh -NoProfile -NonInteractive -Command "\$ErrorActionPreference = 'Stop'; $1"
}

set_default_shell() {
  # $1: `powershell`, `cmd` / empty (OpenSSH's default, cmd.exe), or an
  # executable path (the value being restored).
  local value
  case "$1" in
    "" | cmd)
      run_pwsh "Remove-ItemProperty -Path '$OPENSSH_KEY' -Name DefaultShell -ErrorAction SilentlyContinue"
      return
      ;;
    powershell) value="(Join-Path \$env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe')" ;;
    *) value="'$1'" ;;
  esac
  run_pwsh "New-Item -Path '$OPENSSH_KEY' -Force | Out-Null
    New-ItemProperty -Path '$OPENSSH_KEY' -Name DefaultShell -Value $value -PropertyType String -Force | Out-Null"
}

show_default_shell() {
  run_pwsh "(Get-ItemProperty -Path '$OPENSSH_KEY' -ErrorAction SilentlyContinue).DefaultShell"
}

teardown() {
  local rc=$?
  if [ "$rc" -ne 0 ] && [ -n "${TERMIHUB_NATIVE_SSHD_DIR:-}" ]; then
    local log
    log="$(cygpath -u "$TERMIHUB_NATIVE_SSHD_DIR")/sshd.log"
    if [ -f "$log" ]; then
      echo "---- native sshd log (last 200 lines) ----" >&2
      tail -n 200 "$log" >&2 || true
    fi
  fi
  "$FIXTURE" down || echo "warning: native sshd teardown failed" >&2
  set_default_shell "$PREVIOUS_SHELL" || echo "warning: could not restore the DefaultShell" >&2
  exit "$rc"
}

PREVIOUS_SHELL="$(show_default_shell)"
cargo build -p termihub-agent
AGENT_BIN="${CARGO_TARGET_DIR:-$REPO_ROOT/target}/debug/termihub-agent.exe"

# Armed before `up`, so a half-started fixture is torn down too.
trap teardown EXIT
set_default_shell "$DEFAULT_SHELL"
echo "OpenSSH DefaultShell: $(show_default_shell)"

exports="$("$FIXTURE" up --agent-binary "$AGENT_BIN")"
eval "$exports"

export TERMIHUB_WINDOWS_SSH_DEFAULT_SHELL="$DEFAULT_SHELL"
export TERMIHUB_REQUIRE_WINDOWS_SSH=1
log="$(mktemp)"
# --show-output (not --nocapture): the test's own lines print after it ends, so
# libtest's "test <name> ... ok" line stays contiguous for the check below.
cargo test -p termihub --lib "$TEST_NAME" -- --exact --show-output "$@" 2>&1 | tee "$log"
# Guard against a false green: the named test must have run and passed, and
# must not have skipped.
if ! grep -q "test $TEST_NAME ... ok" "$log"; then
  echo "::error::$TEST_NAME did not run and pass"
  exit 1
fi
if grep -q 'SKIPPED:' "$log"; then
  echo "::error::$TEST_NAME skipped in the Windows SSH-host lane"
  exit 1
fi
