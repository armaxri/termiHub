#!/usr/bin/env bash
#
# Run the live agent deploy -> probe -> update -> reattach journey against the
# native loopback sshd fixture (#5208), on macOS, Linux or Windows (Git Bash).
#
# 1. Builds termihub-agent twice with different TERMIHUB_BUILD_BRANCH labels
#    (build A and the update, build B), copying each into a scratch dir.
# 2. Brings the native sshd fixture up (native-sshd-fixture.sh up
#    --scratch-home: on macOS/Linux every session gets a HOME, XDG dirs and
#    HISTFILE in the fixture's state dir, so nothing lands in the real home).
# 3. Runs src-tauri's native_sshd_deploy_journey_tests with
#    TERMIHUB_REQUIRE_NATIVE_SSHD_DEPLOY=1 (a missing fixture fails, never
#    skips) and fails unless the journey ran and passed.
# 4. Always tears the fixture down and removes the scratch dir; prints the
#    sshd log on failure.
#
# The nightly `native-sshd` job in integration-fixtures.yml runs exactly this
# on ubuntu-latest, macos-latest and windows-latest. On Windows the fixture
# needs an elevated Git Bash, as on the GitHub runner. Locally it reads this
# checkout's test port offset from dev.local.json (read-only).
#
# Usage:
#   scripts/internal/run-native-sshd-deploy-journey.sh [extra cargo test args...]

set -euo pipefail

case "${1:-}" in
  -h | --help)
    sed -n '3,23p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    exit 0
    ;;
esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
FIXTURE="$SCRIPT_DIR/native-sshd-fixture.sh"
TEST_NAME="terminal::agent_manager::native_sshd_deploy_journey_tests::deploy_probe_update_and_reattach_journey"
cd "$REPO_ROOT"

die() {
  echo "::error::$*" >&2
  exit 1
}

# This checkout's port offset, so parallel checkouts get distinct sshd ports.
if [ -f "$SCRIPT_DIR/dev-local-env.sh" ]; then
  # shellcheck source=scripts/internal/dev-local-env.sh
  source "$SCRIPT_DIR/dev-local-env.sh"
fi

EXE=""
CARGO_TARGET_ARGS=()
AGENT_OUT="${CARGO_TARGET_DIR:-$REPO_ROOT/target}/debug"
case "$(uname -s)" in
  MINGW* | MSYS* | CYGWIN*)
    EXE=".exe"
    # The deployed agent links the VC runtime statically, like the released
    # one (see run-windows-ssh-host-suite.sh): the explicit --target keeps the
    # RUSTFLAGS off build scripts and gives the build its own target dir.
    HOST_TRIPLE="$(rustc -vV | awk '/^host:/ { print $2 }')"
    [ -n "$HOST_TRIPLE" ] || die "could not determine the Rust host triple"
    CARGO_TARGET_ARGS=(--target "$HOST_TRIPLE")
    AGENT_OUT="${CARGO_TARGET_DIR:-$REPO_ROOT/target}/$HOST_TRIPLE/debug"
    export RUSTFLAGS="${RUSTFLAGS:+$RUSTFLAGS }-C target-feature=+crt-static"
    ;;
esac

TMP_BASE="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
command -v cygpath >/dev/null 2>&1 && TMP_BASE="$(cygpath -u "$TMP_BASE")"
SCRATCH="$(mktemp -d "${TMP_BASE%/}/termihub-deploy-journey.XXXXXX")"
# The test process wants native paths (C:\... on Windows).
native_path() {
  if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else echo "$1"; fi
}
FIXTURE_UP=0

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
  if [ "$FIXTURE_UP" -eq 1 ]; then
    "$FIXTURE" down || echo "warning: native sshd teardown failed" >&2
  fi
  rm -rf "$SCRATCH"
  exit "$rc"
}
trap teardown EXIT

# Build A, then build B (only the agent crate rebuilds: its build script
# reruns on TERMIHUB_BUILD_BRANCH).
build_agent() {
  local label="$1" dest="$2"
  TERMIHUB_BUILD_BRANCH="$label" cargo build ${CARGO_TARGET_ARGS[@]+"${CARGO_TARGET_ARGS[@]}"} -p termihub-agent ||
    die "could not build termihub-agent ($label)"
  cp "$AGENT_OUT/termihub-agent$EXE" "$dest" || die "built agent not found in $AGENT_OUT"
  echo "built $("$dest" --version) -> $dest"
}
build_agent journey-5208-a "$SCRATCH/termihub-agent-a$EXE"
build_agent journey-5208-b "$SCRATCH/termihub-agent-b$EXE"
# The test crate builds without the static-CRT flags.
unset RUSTFLAGS

# Compile the test binary before the fixture is up, so sshd does not idle
# through a long build.
cargo test -p termihub --lib --no-run || die "could not build the termihub lib tests"

FIXTURE_UP=1
exports="$("$FIXTURE" up --scratch-home)" || die "native sshd fixture failed to come up"
eval "$exports"

TERMIHUB_TEST_AGENT_BIN="$(native_path "$SCRATCH/termihub-agent-a$EXE")"
TERMIHUB_TEST_AGENT_UPDATE_BIN="$(native_path "$SCRATCH/termihub-agent-b$EXE")"
export TERMIHUB_TEST_AGENT_BIN TERMIHUB_TEST_AGENT_UPDATE_BIN
export TERMIHUB_REQUIRE_NATIVE_SSHD_DEPLOY=1
export RUST_BACKTRACE=1

log="$SCRATCH/journey.log"
set +e
cargo test -p termihub --lib "$TEST_NAME" -- --exact --nocapture "$@" 2>&1 | tee "$log"
code="${PIPESTATUS[0]}"
set -e
[ "$code" -eq 0 ] || die "the deploy journey failed (exit $code)"
grep -q "test $TEST_NAME ... ok" "$log" || die "the deploy journey did not run and pass"
if grep -q 'SKIPPED:' "$log"; then
  grep 'SKIPPED:' "$log" >&2
  die "the deploy journey skipped"
fi
echo "deploy -> probe -> update -> reattach journey passed"
