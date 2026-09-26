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
#   serial ONLY the live-agent-TCP tests (SERIAL_FILTERS), one at a time
#          (--test-threads=1), then verify at least SERIAL_MIN_TESTS ran and
#          none was ignored (#2495, #3615). Used by the dedicated Windows job.
#   list   print what each phase selects and verify the partition is exact
#          (bulk + heavy [+ serial] == the full test set, no overlap). Builds,
#          never runs.
#
# CI_RUST_TESTS_SPLIT_SERIAL=1 makes bulk and heavy SKIP the serial set, so it
# can run in its own job instead. Only set it on a leg whose workflow also runs
# the `serial` phase (the Windows legs, #3615) -- otherwise those tests are
# skipped with nothing to run them. Unset (Linux/macOS), they run in bulk.
#
# Both phases pass the same filters (`--skip F` vs `F`) over the same targets,
# so every test runs exactly once -- a test either matches a filter or it does
# not. Filters are libtest substring filters matched against the full test
# path (e.g. `backends::local_shell::tests::foo`), across every binary.
#
# Usage:
#   scripts/internal/ci-rust-tests.sh <bulk|heavy|serial|list> [cargo selection args]
#   scripts/internal/ci-rust-tests.sh bulk --workspace
#   scripts/internal/ci-rust-tests.sh heavy -p termihub-agent -p termihub-core
#   scripts/internal/ci-rust-tests.sh serial -p termihub-agent
#
# `--all-features` is always added. Everything after the phase is passed to
# cargo as the package selection.

set -euo pipefail

usage() {
  sed -n '3,44p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
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

# Live-agent-TCP tests: each cold-starts a real `termihub-agent --listen` and
# drives it over TCP. In the shared parallel Windows leg they oversubscribed the
# runner and timed out on a random test (#2495), so Windows runs them in their
# own serial job (#3615). The prefix is a naming contract -- see
# agent/tests/local_agent_integration.rs.
SERIAL_FILTERS=(
  "live_agent_tcp_"
)
# How many tests the serial set holds today: 16 on unix (15 in
# local_agent_integration.rs + 1 in tcp_listener_readiness.rs), 10 on Windows
# (six of them are `#[cfg(unix)]` daemon-recovery tests). Raise the count when
# adding one; a rename that drops a test out of the prefix then fails the serial
# phase instead of going unseen.
if [ "${OS:-}" = "Windows_NT" ]; then
  SERIAL_MIN_TESTS_DEFAULT=10
else
  SERIAL_MIN_TESTS_DEFAULT=16
fi
SERIAL_MIN_TESTS="${CI_SERIAL_MIN_TESTS:-$SERIAL_MIN_TESTS_DEFAULT}"
SPLIT_SERIAL="${CI_RUST_TESTS_SPLIT_SERIAL:-0}"

phase="${1:-}"
case "$phase" in
  -h | --help)
    usage
    exit 0
    ;;
  bulk | heavy | serial | list)
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

# Skips applied to bulk AND heavy when the serial set runs in its own job.
serial_skip_args=()
if [ "$SPLIT_SERIAL" = "1" ]; then
  for filter in "${SERIAL_FILTERS[@]}"; do
    serial_skip_args+=(--skip "$filter")
  done
fi

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
    if [ "$SPLIT_SERIAL" = "1" ]; then
      echo "  also skipping the serial set (runs in its own job): ${SERIAL_FILTERS[*]}"
    fi
    cargo test "${selection[@]}" "${targets[@]}" -- "${skip_args[@]}" ${serial_skip_args[@]+"${serial_skip_args[@]}"}
    cargo test "${selection[@]}" --all-features --doc
    ;;
  heavy)
    echo "runner cores: $(cores); heavy phase: --test-threads=${HEAVY_TEST_THREADS}"
    printf '  filter: %s\n' "${HEAVY_FILTERS[@]}"
    cargo test "${selection[@]}" "${targets[@]}" -- \
      --test-threads="$HEAVY_TEST_THREADS" "${HEAVY_FILTERS[@]}" ${serial_skip_args[@]+"${serial_skip_args[@]}"}
    ;;
  serial)
    echo "runner cores: $(cores); serial phase: --test-threads=1, expecting >= ${SERIAL_MIN_TESTS} test(s)"
    printf '  filter: %s\n' "${SERIAL_FILTERS[@]}"
    log="$(mktemp)"
    trap 'rm -f "$log"' EXIT
    status=0
    cargo test "${selection[@]}" "${targets[@]}" -- \
      --test-threads=1 --nocapture "${SERIAL_FILTERS[@]}" 2>&1 | tee "$log" || status=$?
    # Sum libtest's per-binary summaries. A guard, not a formality: a filter that
    # silently matched nothing would otherwise "pass" with zero tests run.
    read -r passed failed ignored < <(
      tr -d '\r' <"$log" |
        grep -oE 'test result: [A-Za-z]+\. [0-9]+ passed; [0-9]+ failed; [0-9]+ ignored' |
        awk '{p += $4; f += $6; i += $8} END {print p + 0, f + 0, i + 0}'
    )
    echo "serial phase: passed=${passed} failed=${failed} ignored=${ignored} (cargo exit ${status})"
    if [ "$status" -ne 0 ]; then
      exit "$status"
    fi
    if [ "$ignored" -ne 0 ]; then
      echo "serial phase: ${ignored} live-agent test(s) were IGNORED -- none may be quarantined (#3615)" >&2
      exit 1
    fi
    if [ "$passed" -lt "$SERIAL_MIN_TESTS" ]; then
      echo "serial phase: only ${passed} test(s) ran, expected >= ${SERIAL_MIN_TESTS}." >&2
      echo "  A live-agent test lost its live_agent_tcp_ prefix, or the selection is wrong." >&2
      exit 1
    fi
    ;;
  list)
    export LC_ALL=C
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT
    list_tests >"$tmp/all"
    list_tests "${skip_args[@]}" ${serial_skip_args[@]+"${serial_skip_args[@]}"} >"$tmp/bulk"
    list_tests "${HEAVY_FILTERS[@]}" ${serial_skip_args[@]+"${serial_skip_args[@]}"} >"$tmp/heavy"
    : >"$tmp/serial"
    if [ "$SPLIT_SERIAL" = "1" ]; then
      list_tests "${SERIAL_FILTERS[@]}" >"$tmp/serial"
    fi
    echo "heavy tests:"
    sed 's/^/  /' "$tmp/heavy"
    for filter in "${HEAVY_FILTERS[@]}"; do
      echo "filter ${filter}: $(grep -cF -- "$filter" "$tmp/heavy" || true) test(s)"
    done
    if [ "$SPLIT_SERIAL" = "1" ]; then
      echo "serial tests:"
      sed 's/^/  /' "$tmp/serial"
    fi
    echo "all=$(wc -l <"$tmp/all") bulk=$(wc -l <"$tmp/bulk") heavy=$(wc -l <"$tmp/heavy") serial=$(wc -l <"$tmp/serial")"
    overlap="$(($(comm -12 "$tmp/bulk" "$tmp/heavy" | wc -l) + $(comm -12 "$tmp/bulk" "$tmp/serial" | wc -l) + $(comm -12 "$tmp/heavy" "$tmp/serial" | wc -l)))"
    LC_ALL=C sort -m "$tmp/bulk" "$tmp/heavy" "$tmp/serial" >"$tmp/union"
    if [ "$overlap" -ne 0 ] || ! cmp -s "$tmp/all" "$tmp/union"; then
      echo "partition NOT exact (overlap=${overlap})" >&2
      diff "$tmp/all" "$tmp/union" >&2 || true
      exit 1
    fi
    echo "partition exact: every test runs in exactly one phase"
    ;;
esac
