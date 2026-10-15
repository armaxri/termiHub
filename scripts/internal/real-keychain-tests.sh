#!/usr/bin/env bash
#
# Run the opt-in real-keychain tests of the deferred backup-restore credential
# import (#4659, src-tauri/src/backup/tests_real_keychain.rs) against a
# throwaway OS credential store, and fail unless every one of them ran.
#
#   macOS    a temporary keychain becomes the default (and joins the search
#            list) only while the prebuilt test binary runs; the original
#            default and search list are restored and the keychain deleted on
#            exit. The login keychain is never written.
#   Linux    a private D-Bus session (dbus-run-session) with its own
#            gnome-keyring-daemon, whose keyring files and sockets live in a
#            temporary directory. Needs dbus-run-session and gnome-keyring.
#   Windows  the user's Credential Manager (it has no throwaway store); the
#            tests only use run-unique service names and delete every entry
#            they write.
#
# The tests themselves never touch the keyring unless
# TERMIHUB_REAL_KEYCHAIN_TESTS=1, which this script sets.
#
# Usage: scripts/internal/real-keychain-tests.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

FILTER="backup::tests_real_keychain::"
EXPECTED=2
# The same package selection and features as the CI "Run Rust tests" step, so
# CI reuses its already-built lib test binaries instead of rebuilding. The
# filter only matches tests in the termihub lib.
CARGO_ARGS=(--workspace --all-features --lib)
TEST_ARGS=("$FILTER" --test-threads=1)

WORK="$(mktemp -d)"
LOG="$WORK/test.log"
export TERMIHUB_REAL_KEYCHAIN_TESTS=1

ORIG_DEFAULT=""
ORIG_LIST=()
KEYCHAIN=""

cleanup() {
  if [[ -n "$KEYCHAIN" ]]; then
    if [[ -n "$ORIG_DEFAULT" ]]; then
      security default-keychain -d user -s "$ORIG_DEFAULT" || true
    fi
    if ((${#ORIG_LIST[@]} > 0)); then
      security list-keychains -d user -s "${ORIG_LIST[@]}" || true
    fi
    security delete-keychain "$KEYCHAIN" 2>/dev/null || true
    echo "Restored the default keychain: $(security default-keychain -d user | tr -d ' "')"
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

# Strip the indentation and quotes `security` prints around keychain paths.
unquote() {
  sed -e 's/^[[:space:]]*"//' -e 's/"[[:space:]]*$//'
}

# Build first, so a throwaway store is only active while the tests run.
echo "Building the test binary..."
cargo test "${CARGO_ARGS[@]}" --no-run

case "$(uname -s)" in
  Darwin)
    ORIG_DEFAULT="$(security default-keychain -d user | unquote)"
    while IFS= read -r line; do
      ORIG_LIST+=("$line")
    done < <(security list-keychains -d user | unquote)
    KEYCHAIN="$WORK/termihub-real-keychain-tests.keychain-db"
    password="termihub-$RANDOM-$RANDOM"
    security create-keychain -p "$password" "$KEYCHAIN"
    # No auto-lock timeout, so the keychain stays unlocked for the run.
    security set-keychain-settings "$KEYCHAIN"
    security unlock-keychain -p "$password" "$KEYCHAIN"
    security list-keychains -d user -s "$KEYCHAIN" ${ORIG_LIST[@]+"${ORIG_LIST[@]}"}
    security default-keychain -d user -s "$KEYCHAIN"
    echo "Using the throwaway keychain $KEYCHAIN"
    cargo test "${CARGO_ARGS[@]}" -- "${TEST_ARGS[@]}" 2>&1 | tee "$LOG"
    ;;
  Linux)
    for tool in dbus-run-session gnome-keyring-daemon; do
      command -v "$tool" >/dev/null || {
        echo "error: $tool is required (install dbus and gnome-keyring)" >&2
        exit 1
      }
    done
    mkdir -m 700 "$WORK/runtime" "$WORK/data"
    # The keyring lives in $XDG_DATA_HOME/keyrings, its control socket in
    # $XDG_RUNTIME_DIR: both temporary, so a developer's real keyring is
    # never opened. An empty password creates and unlocks a fresh one.
    XDG_RUNTIME_DIR="$WORK/runtime" XDG_DATA_HOME="$WORK/data" \
      dbus-run-session -- bash -c '
        set -euo pipefail
        printf "" | gnome-keyring-daemon --unlock --components=secrets >/dev/null
        cargo test "$@"
      ' real-keychain-tests "${CARGO_ARGS[@]}" -- "${TEST_ARGS[@]}" 2>&1 | tee "$LOG"
    ;;
  MINGW* | MSYS* | CYGWIN*)
    cargo test "${CARGO_ARGS[@]}" -- "${TEST_ARGS[@]}" 2>&1 | tee "$LOG"
    ;;
  *)
    echo "error: unsupported platform $(uname -s)" >&2
    exit 1
    ;;
esac

# A filter that matches nothing passes silently; require every test to have
# run and passed.
ran="$(grep -cE "^test ${FILTER}[a-z_]+ \.\.\. ok\$" "$LOG" || true)"
if [[ "$ran" != "$EXPECTED" ]]; then
  echo "error: expected $EXPECTED real-keychain tests to pass, $ran did" >&2
  exit 1
fi
echo "All $EXPECTED real-keychain tests passed against the real OS credential store."
