#!/usr/bin/env bash
#
# Run the fish login-shell journeys of core/tests/ssh_native.rs against a REAL
# fish 3.x login shell (#5115).
#
# termiHub types a hidden setup line at a fish prompt and removes its echo
# with a cell-redraw screen model (#5094). fish 4 announces itself and has its
# own command marks; fish 3 gets the typed fish hook instead, so the two take
# different paths. This makes fish 3 the native sshd fixture user's login
# shell, runs native_05b..05d with TERMIHUB_NATIVE_SSHD_LOGIN_SHELL=fish3 and
# the setup byte trace on (TERMIHUB_TEST_SSH_TRACE=1), requires all three to
# pass, and puts the old login shell back afterwards.
#
# It CHANGES THE CURRENT USER'S LOGIN SHELL (via `sudo usermod`) for the run,
# so it refuses to run outside a throwaway CI runner unless
# --allow-login-shell-change is given. Linux only (usermod / getent).
#
# The nightly `native-sshd` job in integration-fixtures.yml runs this on its
# ubuntu leg with --install-debian-fish3: Ubuntu itself ships fish 4 now, so
# Debian bookworm's fish 3.6 packages are fetched, checked against pinned
# SHA-256 sums and installed (apt pulls their few library deps).
#
# Usage:
#   scripts/internal/run-native-sshd-fish3-suite.sh [--log PATH]
#       [--fish PATH] [--install-debian-fish3] [--allow-login-shell-change]
#
#   --log PATH               where the test output + setup trace go
#                            (default: $RUNNER_TEMP or $TMPDIR, fish3-ssh-trace.log)
#   --fish PATH              the fish 3 binary (default: `fish` on PATH)
#   --install-debian-fish3   first install bookworm's fish 3.6 (apt, sudo)

set -euo pipefail

usage() {
  sed -n '3,31p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

die() {
  echo "error: $*" >&2
  exit 1
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SUITES="$SCRIPT_DIR/run-native-sshd-suites.sh"
TESTS=(
  native_05b_remote_shell_probe_detects_the_login_shell
  native_05c_first_command_runs_with_shell_integration_on
  native_05d_env_vars_apply_in_the_login_shell_and_first_command_runs
)

LOG="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
LOG="${LOG%/}/fish3-ssh-trace.log"
FISH=""
ALLOW=0
INSTALL=0

# Debian bookworm's fish 3.6 (deb.debian.org pool; bump both sums with the
# version if a bookworm point release replaces it).
DEBIAN_POOL="https://deb.debian.org/debian/pool/main/f/fish"
FISH3_DEBS=(
  "fish-common_3.6.0-3.1+deb12u1_all.deb 7386d9ae1851784c9ab3818f18389dbe33f4961f48617393509e2cc99ac6b6e1"
  "fish_3.6.0-3.1+deb12u1_amd64.deb ffe12d263ef84a49554205e7c6607d81bc4f78f350194aab303a9a7a7888bbab"
)

install_debian_fish3() {
  local dir entry name sum paths=()
  dir="$(mktemp -d)"
  for entry in "${FISH3_DEBS[@]}"; do
    name="${entry% *}"
    sum="${entry#* }"
    curl -fsSL --retry 3 -o "$dir/$name" "$DEBIAN_POOL/$name" || die "could not download $name"
    echo "$sum  $dir/$name" | sha256sum -c --quiet - || die "$name does not match its pinned SHA-256"
    paths+=("$dir/$name")
  done
  # Retry transient mirror failures (#5152).
  sudo apt-get -o Acquire::Retries=5 -o Acquire::http::Timeout=30 update -q
  sudo apt-get -o Acquire::Retries=5 -o Acquire::http::Timeout=30 install -y -q --no-install-recommends --allow-downgrades "${paths[@]}"
  rm -rf "$dir"
}
while [ $# -gt 0 ]; do
  case "$1" in
    -h | --help)
      usage
      exit 0
      ;;
    --log)
      [ $# -ge 2 ] || die "--log needs a path"
      LOG="$2"
      shift 2
      ;;
    --fish)
      [ $# -ge 2 ] || die "--fish needs a path"
      FISH="$2"
      shift 2
      ;;
    --allow-login-shell-change)
      ALLOW=1
      shift
      ;;
    --install-debian-fish3)
      INSTALL=1
      shift
      ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
done

[ "$(uname -s)" = Linux ] || die "Linux only (it switches the login shell with usermod)"
if [ "$ALLOW" -ne 1 ] && [ "${GITHUB_ACTIONS:-}" != true ]; then
  die "this changes your login shell for the run; pass --allow-login-shell-change"
fi

[ "$INSTALL" -eq 0 ] || install_debian_fish3
if [ -z "$FISH" ]; then
  FISH="$(command -v fish)" || die "no fish on PATH (apt-get install fish, or pass --fish)"
fi
[ -x "$FISH" ] || die "fish binary not executable: $FISH"
version="$("$FISH" --version)" || die "could not run $FISH --version"
echo "login shell under test: $FISH ($version)"
case "$version" in
  *"version 3."*) ;;
  *) die "not a fish 3.x: '$version' (this lane grades fish 3; fish 4 is LOGIN_SHELL=fish)" ;;
esac

USER_NAME="$(id -un)"
ORIG_SHELL="$(getent passwd "$USER_NAME" | cut -d: -f7)"
[ -n "$ORIG_SHELL" ] || die "could not read the login shell of $USER_NAME"

restore() {
  local rc=$?
  if [ "$(getent passwd "$USER_NAME" | cut -d: -f7)" != "$ORIG_SHELL" ]; then
    sudo usermod -s "$ORIG_SHELL" "$USER_NAME" ||
      echo "warning: could not restore the login shell to $ORIG_SHELL" >&2
  fi
  exit "$rc"
}
trap restore EXIT

sudo usermod -s "$FISH" "$USER_NAME"
now="$(getent passwd "$USER_NAME" | cut -d: -f7)"
[ "$now" = "$FISH" ] || die "login shell is '$now' after usermod, expected '$FISH'"

mkdir -p "$(dirname "$LOG")"
cd "$REPO_ROOT"
export TERMIHUB_NATIVE_SSHD_LOGIN_SHELL=fish3
# Every byte the setup sequence types and receives (#4670), for the transcript.
export TERMIHUB_TEST_SSH_TRACE=1
set +e
"$SUITES" -- --test-threads=1 --show-output "${TESTS[@]}" 2>&1 | tee "$LOG"
rc=${PIPESTATUS[0]}
set -e
echo "test output + setup trace: $LOG"
[ "$rc" -eq 0 ] || die "the fish 3 journeys failed (exit $rc)"

for name in "${TESTS[@]}"; do
  grep -q "test $name ... ok" "$LOG" || die "$name did not run and pass"
done
if grep -q 'SKIPPED:' "$LOG"; then
  grep 'SKIPPED:' "$LOG" >&2
  die "a fish 3 journey skipped"
fi
echo "fish 3 journeys passed: ${TESTS[*]}"
