#!/usr/bin/env bash
#
# Split Rust test run for CI (audit finding CI-013, #3350).
#
# `cargo test --workspace` runs every test binary at the default parallelism
# (one thread per core). A handful of suites are contention-sensitive: they
# spawn real processes (PTY shells), host embedded servers (russh), or assert
# on timing across a reconnect. Run alongside ~4000 light tests -- including
# CPU-bound Argon2 KDF tests -- on a 4-core runner, they get starved and time
# out on a random test, reddening unrelated PRs (Windows worst: #2498, #2719,
# #3310, the #2495 quarantine).
#
# This script partitions the tests with ONE filter list (HEAVY_FILTERS below):
#
#   bulk   every test NOT matching a heavy filter, at default parallelism,
#          plus the doc-tests (none of which are contention-sensitive).
#   heavy  ONLY the tests matching a heavy filter, with --test-threads capped
#          (CI_HEAVY_TEST_THREADS, default 2), after the bulk has finished, so
#          nothing else competes for the cores.
#   list   print what each phase selects and verify the partition is exact
#          (bulk + heavy == the full test set, no overlap). Builds, never runs.
#
# Both phases pass the same filters (`--skip F` vs `F`) over the same targets,
# so every test runs exactly once -- a test either matches a filter or it does
# not. Filters are libtest substring filters matched against the full test
# path (e.g. `backends::local_shell::tests::foo`), across every binary.
#
# Usage:
#   scripts/internal/ci-rust-tests.sh <bulk|heavy|list> [cargo selection args]
#   scripts/internal/ci-rust-tests.sh bulk --workspace
#   scripts/internal/ci-rust-tests.sh heavy -p termihub-agent -p termihub-core
#
# `--all-features` is always added. Everything after the phase is passed to
# cargo as the package selection.

set -euo pipefail

usage() {
  sed -n '3,33p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

# Contention-sensitive tests, as libtest substring filters. Add a module here
# (with its evidence) when it flakes under load; never to hide a real bug.
HEAVY_FILTERS=(
  # PTY shell sessions: spawn a real shell per test (#2498).
  "backends::local_shell::"
  # Remote-forward relays over real sockets, stats asserted after relay (#2395).
  "tunnel::remote_forward::"
  # Reconnect redrive through the session projection, timing-sensitive
  # (flaked on the Windows leg 2026-09-25, and #2719).
  "session_projection::redrive_resume_tests::"
  # Embedded russh server + agent daemon, sever/reattach cycles (~6s each).
  "terminal::agent_manager::russh_reconnect_tests::"
)

HEAVY_TEST_THREADS="${CI_HEAVY_TEST_THREADS:-2}"

phase="${1:-}"
case "$phase" in
  -h | --help)
    usage
    exit 0
    ;;
  bulk | heavy | list)
    shift
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac

selection=("$@")
if [ "${#selection[@]}" -eq 0 ]; then
  selection=(--workspace)
fi

# The non-doc test targets. The workspace has no example or bench targets, so
# this plus `--doc` is exactly what a plain `cargo test` runs.
targets=(--all-features --lib --bins --tests)

skip_args=()
for filter in "${HEAVY_FILTERS[@]}"; do
  skip_args+=(--skip "$filter")
done

cores() {
  getconf _NPROCESSORS_ONLN 2>/dev/null || echo "${NUMBER_OF_PROCESSORS:-unknown}"
}

# `cargo test -- --list` output reduced to sorted "<binary> <test>" lines, so
# identical test names in different binaries stay distinct.
list_tests() {
  CARGO_TERM_COLOR=never LC_ALL=C cargo test "${selection[@]}" "${targets[@]}" -- --list --format terse "$@" 2>&1 |
    awk '/^ *Running /{bin=$NF} / (test|benchmark)$/{sub(/: (test|benchmark)$/, ""); print bin, $0}' |
    sed -E 's/-[0-9a-f]{16}(\.exe)?\)$/)/' |
    LC_ALL=C sort
}

case "$phase" in
  bulk)
    echo "runner cores: $(cores); bulk phase: default parallelism, skipping ${#HEAVY_FILTERS[@]} heavy filter(s)"
    cargo test "${selection[@]}" "${targets[@]}" -- "${skip_args[@]}"
    cargo test "${selection[@]}" --all-features --doc
    ;;
  heavy)
    echo "runner cores: $(cores); heavy phase: --test-threads=${HEAVY_TEST_THREADS}"
    printf '  filter: %s\n' "${HEAVY_FILTERS[@]}"
    cargo test "${selection[@]}" "${targets[@]}" -- \
      --test-threads="$HEAVY_TEST_THREADS" "${HEAVY_FILTERS[@]}"
    ;;
  list)
    export LC_ALL=C
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT
    list_tests >"$tmp/all"
    list_tests "${skip_args[@]}" >"$tmp/bulk"
    list_tests "${HEAVY_FILTERS[@]}" >"$tmp/heavy"
    echo "heavy tests:"
    sed 's/^/  /' "$tmp/heavy"
    for filter in "${HEAVY_FILTERS[@]}"; do
      echo "filter ${filter}: $(grep -cF -- "$filter" "$tmp/heavy" || true) test(s)"
    done
    echo "all=$(wc -l <"$tmp/all") bulk=$(wc -l <"$tmp/bulk") heavy=$(wc -l <"$tmp/heavy")"
    overlap="$(comm -12 "$tmp/bulk" "$tmp/heavy" | wc -l)"
    LC_ALL=C sort -m "$tmp/bulk" "$tmp/heavy" >"$tmp/union"
    if [ "$overlap" -ne 0 ] || ! cmp -s "$tmp/all" "$tmp/union"; then
      echo "partition NOT exact (overlap=${overlap})" >&2
      diff "$tmp/all" "$tmp/union" >&2 || true
      exit 1
    fi
    echo "partition exact: every test runs in exactly one phase"
    ;;
esac
