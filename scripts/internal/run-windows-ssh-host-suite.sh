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

teardown() {
  local rc=$?
  if [ "$rc" -ne 0 ] && [ -n "${TERMIHUB_NATIVE_SSHD_DIR:-}" ]; then
    print_sshd_log || true
  fi
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
cargo build -p termihub-agent || die "could not build termihub-agent"
AGENT_BIN="${CARGO_TARGET_DIR:-$REPO_ROOT/target}/debug/termihub-agent.exe"
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
if ! grep -q "test $TEST_NAME ... ok" "$log"; then
  echo "::error::$TEST_NAME did not run and pass"
  exit 1
fi
if grep -q 'SKIPPED:' "$log"; then
  echo "::error::$TEST_NAME skipped in the Windows SSH-host lane"
  exit 1
fi
