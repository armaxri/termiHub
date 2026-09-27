#!/usr/bin/env bash
#
# Run the native-sshd SSH/SFTP core suites end to end (CI-020, TIN-007).
#
# Stands up the native loopback sshd fixture (native-sshd-fixture.sh, which
# hands over to native-sshd-fixture.ps1 on Windows), runs
# core/tests/ssh_native.rs against it with TERMIHUB_NATIVE_SSHD=1 (so a broken
# fixture hard-fails instead of skipping), prints the sshd log on failure, and
# always tears the fixture down again.
#
# The nightly `native-sshd` job in integration-fixtures.yml runs exactly this
# on macos-latest, windows-latest and ubuntu-latest. The recipe lives here,
# in the checked-out tree, so a scheduled run (which uses main's copy of the
# workflow) still runs develop's recipe.
#
# Usage:
#   scripts/internal/run-native-sshd-suites.sh [extra cargo test args...]
#   scripts/internal/run-native-sshd-suites.sh -- --nocapture
#
# Extra arguments are appended to the `cargo test` command line.

set -euo pipefail

case "${1:-}" in
  -h | --help)
    sed -n '3,21p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    exit 0
    ;;
esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
FIXTURE="$SCRIPT_DIR/native-sshd-fixture.sh"
cd "$REPO_ROOT"

teardown() {
  local rc=$?
  if [ "$rc" -ne 0 ] && [ -n "${TERMIHUB_NATIVE_SSHD_DIR:-}" ]; then
    local log="$TERMIHUB_NATIVE_SSHD_DIR/sshd.log"
    command -v cygpath >/dev/null 2>&1 && log="$(cygpath -u "$log")"
    if [ -f "$log" ]; then
      echo "---- native sshd log (last 200 lines) ----" >&2
      tail -n 200 "$log" >&2 || true
    fi
  fi
  "$FIXTURE" down || echo "warning: native sshd teardown failed" >&2
  exit "$rc"
}

# Armed before `up`, so a half-started fixture (sshd up, self-test failed) is
# torn down too.
trap teardown EXIT
exports="$("$FIXTURE" up)"
eval "$exports"

cargo test -p termihub-core --features ssh --test ssh_native "$@"
