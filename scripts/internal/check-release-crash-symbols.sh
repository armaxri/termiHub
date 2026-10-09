#!/usr/bin/env bash
#
# Prove a release-profile build writes a crash report whose backtrace names
# termiHub functions (#4316, audit OBS2-001).
#
# The desktop and agent panic hooks write a crash report with a std backtrace.
# std can only name a frame from the binary's own symbol table, so while the
# release profile used `strip = true` every frame of a shipped build's report
# read `<unknown>`. The profile now uses `strip = "debuginfo"`; this check keeps
# it that way.
#
# It builds tests/release-crash-probe with the workspace's real
# [profile.release] (or uses the binary given as $1), runs it — the probe
# installs a hook that calls the same CrashDetails::capture + write_report path
# as the real hooks, then panics — and fails unless the report's backtrace has a
# resolved `termihub_core::` frame.
#
# Usage:
#   scripts/internal/check-release-crash-symbols.sh [<probe-binary>]
#   scripts/internal/check-release-crash-symbols.sh --help
#
# Exit status: 0 = resolved frame found, 1 = no resolved frame / no report,
# 2 = usage. Runs per PR in agent.yml (job "Release crash-report symbols") on
# Ubuntu. Not meaningful on Windows: MSVC keeps symbols in an unshipped .pdb.

set -euo pipefail

usage() {
  sed -n '2,/^$/{s/^# \{0,1\}//;p;}' "${BASH_SOURCE[0]}"
}

case "${1:-}" in
  -h | --help)
    usage
    exit 0
    ;;
esac
if [ "$#" -gt 1 ]; then
  usage >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

if [ "$#" -eq 1 ]; then
  probe="$1"
else
  echo "Building the crash probe with the release profile..."
  (cd "$REPO_ROOT" && cargo build --release --locked -p termihub-crash-probe)
  target_dir="${CARGO_TARGET_DIR:-$REPO_ROOT/target}"
  probe="$target_dir/release/termihub-crash-probe"
fi
if [ ! -x "$probe" ]; then
  echo "::error::crash probe binary not found or not executable: $probe" >&2
  exit 1
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# The probe panics on purpose; a zero exit means it did not.
if "$probe" "$work/crash-reports" 2>"$work/stderr.log"; then
  cat "$work/stderr.log" >&2
  echo "::error::the crash probe exited 0; it should have panicked" >&2
  exit 1
fi

reports=("$work"/crash-reports/crash-*.txt)
if [ ! -f "${reports[0]}" ]; then
  cat "$work/stderr.log" >&2
  echo "::error::the crash probe wrote no crash report" >&2
  exit 1
fi
report="${reports[0]}"

echo "----- crash report -----"
cat "$report"
echo "------------------------"

# The backtrace section: from the "backtrace:" line up to the first blank line.
backtrace="$(sed -n '/^backtrace:$/,/^$/p' "$report")"
if printf '%s\n' "$backtrace" | grep -Eq '[0-9]+: .*termihub_core::'; then
  echo "OK: the release crash report names termiHub functions."
  exit 0
fi
echo "::error::the release crash report has no resolved termihub_core frame;" \
  "is [profile.release] stripping the symbol table (strip = true)? See #4316." >&2
exit 1
