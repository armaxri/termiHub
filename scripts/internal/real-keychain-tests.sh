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
# The Windows twin is real-keychain-tests.cmd.
#
# Usage: scripts/internal/real-keychain-tests.sh [--help]

set -euo pipefail

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  sed -n '3,24p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 0
fi
if (($# > 0)) && [[ -z "${TERMIHUB_REAL_KEYCHAIN_INSIDE_BUS:-}" ]]; then
  echo "error: unknown argument $1 (see --help)" >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

FILTER="backup::tests_real_keychain::"
EXPECTED=2
# The same package selection and features as the CI "Run Rust tests" step, so
# CI reuses its already-built lib test binaries instead of rebuilding. The
# filter only matches tests in the termihub lib.
CARGO_ARGS=(--workspace --all-features --lib)
TEST_ARGS=("$FILTER" --test-threads=1)

# Linux, inside the private session bus: start a fresh gnome-keyring there,
# export the environment it prints (GNOME_KEYRING_CONTROL, ... as VAR=value
# lines), check it has a `default` collection, then run cargo with "$@".
run_inside_session_bus() {
  local line alias_path
  while IFS= read -r line; do
    if [[ "$line" == *=* ]]; then
      export "${line?}"
    fi
  done < <(printf '%s' "termihub-$RANDOM-$RANDOM" |
    gnome-keyring-daemon --unlock --components=secrets)
  if command -v gdbus >/dev/null; then
    alias_path="$(gdbus call --session --dest org.freedesktop.secrets \
      --object-path /org/freedesktop/secrets \
      --method org.freedesktop.Secret.Service.ReadAlias default)"
    echo "Secret Service default collection: $alias_path"
    if [[ "$alias_path" == *"'/'"* ]]; then
      echo "error: the throwaway gnome-keyring has no default collection" >&2
      exit 1
    fi
  fi
  TERMIHUB_REAL_KEYCHAIN_TESTS=1 cargo test "$@"
}

# Set only by the Linux branch below, for its re-run inside the session bus.
if [[ -n "${TERMIHUB_REAL_KEYCHAIN_INSIDE_BUS:-}" ]]; then
  run_inside_session_bus "$@"
  exit 0
fi

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
    # never opened. `--unlock` reads a password on stdin and creates the
    # `login` keyring with it, which becomes the `default` collection the
    # keyring crate writes to. The password must not be empty: with an empty
    # one no login keyring is created, so there is no `default` collection
    # and every call fails with "result not returned from SS API".
    # The script re-runs itself inside the private session bus (see
    # run_inside_session_bus above).
    XDG_RUNTIME_DIR="$WORK/runtime" XDG_DATA_HOME="$WORK/data" \
      TERMIHUB_REAL_KEYCHAIN_INSIDE_BUS=1 \
      dbus-run-session -- "$REPO_ROOT/scripts/internal/real-keychain-tests.sh" \
      "${CARGO_ARGS[@]}" -- "${TEST_ARGS[@]}" 2>&1 | tee "$LOG"
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
