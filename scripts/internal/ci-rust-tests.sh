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
#          none was ignored (#2495, #3615); killed at CI_SERIAL_TIMEOUT_SECS.
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
# The non-doc tests run under cargo-nextest (`cargo nextest run --profile ci`,
# #5345): every test gets a per-test timeout (.config/nextest.toml: SLOW after
# 60s, killed and failed by name after 180s), the run never stops at the first
# failure, and each phase leaves a JUnit report at
# target/nextest/ci/junit-<phase>.xml. Nextest accepts libtest's filter syntax
# (`-- --skip F` / `F`, substring against the full test path), so the
# partition below is unchanged; it runs each test in its own process, so the
# `#[serial(key)]` groups are mirrored as nextest test groups (`list` checks
# every key has one). CI requires nextest (pinned in .github/cargo-tools.json);
# a local run without it falls back to `cargo test`. Doc-tests stay on
# `cargo test --doc` (nextest does not run them).
#
# CI_RUST_TESTS_COVERAGE=1 runs bulk, heavy and serial under cargo-llvm-cov
# (`cargo llvm-cov --no-report` in place of `cargo test`), so a
# coverage lane keeps the same partition and the same thread caps. The phases'
# profiles accumulate; the caller cleans first (`cargo llvm-cov clean
# --workspace`) and writes the report after (scripts/coverage.sh --split, the
# Windows coverage leg, #5160). Doc-tests are skipped there: llvm-cov measures
# them only on nightly, and the Linux coverage run does not count them either.
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
  sed -n '3,64p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

# Contention-sensitive tests, as libtest substring filters. Add a module here
# (with its evidence) when it flakes under load; never to hide a real bug.
HEAVY_FILTERS=(
  # PTY shell sessions: spawn a real shell per test (#2498).
  "backends::local_shell::"
  # Real PTY on the sideloaded ConPTY host, asserts a startup-time budget
  # (core/tests/sideloaded_conpty.rs, Windows only, #4130).
  "sideloaded_conpty_"
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
# How many tests the serial set holds today: 24 on unix (17 in
# local_agent_integration.rs + 1 in tcp_listener_readiness.rs + 6 in
# deferred_update_hook_integration.rs, #5218), 26 on Windows (one of the unix
# local_agent ones, the exactly-once replay count, is `#[cfg(unix)]`; the other
# daemon-recovery tests run over named pipes there too, #3684; two
# `#[cfg(windows)]` ConPTY shell-session tests, #3685, and the deferred-hook
# fail-closed apply test, #5218, run only there). Raise the count when adding
# one; a rename that drops a test out of the prefix then fails the serial phase
# instead of going unseen.
if [ "${OS:-}" = "Windows_NT" ]; then
  SERIAL_MIN_TESTS_DEFAULT=26
else
  SERIAL_MIN_TESTS_DEFAULT=24
fi
SERIAL_MIN_TESTS="${CI_SERIAL_MIN_TESTS:-$SERIAL_MIN_TESTS_DEFAULT}"
# Hard ceiling for the whole serial phase (incremental build + the tests). The
# Windows tests take ~20s plus the two shell cold starts (#3685); on a timeout
# the phase is killed and the last started test is named, instead of the job
# silently eating its own timeout.
SERIAL_TIMEOUT_SECS="${CI_SERIAL_TIMEOUT_SECS:-1200}"
SPLIT_SERIAL="${CI_RUST_TESTS_SPLIT_SERIAL:-0}"
COVERAGE="${CI_RUST_TESTS_COVERAGE:-0}"

NEXTEST_PROFILE="${CI_NEXTEST_PROFILE:-ci}"
TARGET_DIR="${CARGO_TARGET_DIR:-target}"

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

# The runner each run phase uses: nextest (see the header), or libtest via
# `cargo test` -- the instrumented coverage run (profiles accumulate across
# phases; see the header), or a local run without nextest installed.
if [ "$COVERAGE" = "1" ]; then
  runner=libtest
  test_cmd=(cargo llvm-cov --no-report)
elif cargo nextest --version >/dev/null 2>&1; then
  runner=nextest
  test_cmd=(cargo nextest run --profile "$NEXTEST_PROFILE" --no-fail-fast --no-tests=warn)
elif [ -n "${CI:-}" ]; then
  echo "ci-rust-tests.sh: cargo-nextest is required on CI (#5345); install the version" >&2
  echo "  pinned in .github/cargo-tools.json (taiki-e/install-action)" >&2
  exit 1
else
  echo "note: cargo-nextest not found; running under plain cargo test (no per-test timeout)"
  runner=libtest
  test_cmd=(cargo test)
fi

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

# The log as plain text: no CR (Windows) and no colour escapes (nextest colours
# its output on CI, so "Summary"/"START" do not start their lines otherwise).
plain_log() {
  tr -d '\r' <"$1" | sed -E $'s/\x1b\\[[0-9;]*[A-Za-z]//g'
}

# Set `run` to the phase's test command. $1: thread cap ("" = the runner's
# default); $2: 1 = do not capture test output (serial phase); the rest: libtest
# filter args, which nextest accepts after `--` too. Only the thread and capture
# flags differ: nextest takes them before `--`, libtest after.
set_run() {
  local threads="$1" nocapture="$2"
  shift 2
  local before=() after=()
  if [ "$runner" = "nextest" ]; then
    # --no-capture already runs one test at a time (and rejects a thread cap).
    if [ "$nocapture" = "1" ]; then
      before+=(--no-capture)
    elif [ -n "$threads" ]; then
      before+=(--test-threads "$threads")
    fi
  else
    if [ -n "$threads" ]; then after+=(--test-threads="$threads"); fi
    if [ "$nocapture" = "1" ]; then after+=(--nocapture); fi
  fi
  run=("${test_cmd[@]}" "${selection[@]}" "${targets[@]}" ${before[@]+"${before[@]}"}
    -- ${after[@]+"${after[@]}"} "$@")
}

# Keep this phase's nextest JUnit report (each run overwrites junit.xml).
keep_junit() {
  local dir="$TARGET_DIR/nextest/$NEXTEST_PROFILE"
  if [ "$runner" = "nextest" ] && [ -f "$dir/junit.xml" ]; then
    mv -f "$dir/junit.xml" "$dir/junit-${phase}.xml"
  fi
}

# Run the phase's tests; the exit status is the runner's.
run_tests() {
  set_run "$@"
  local status=0
  "${run[@]}" || status=$?
  keep_junit
  return "$status"
}

cores() {
  getconf _NPROCESSORS_ONLN 2>/dev/null || echo "${NUMBER_OF_PROCESSORS:-unknown}"
}

# Fail when a workspace build script watches a path that does not exist.
# Cargo treats such a `rerun-if-changed` path as permanently stale, so the script
# re-runs on EVERY cargo invocation and its crate -- and everything above it --
# recompiles: each Run Tests leg rebuilt core/agent/termihub three times (#3909).
# Builds the phase's selection (the test run after it is then a no-op build) and
# checks each workspace package's build-script `output`. Skipped on Windows,
# where the paths are native and the check would need a path translation; the
# bug class is not platform-specific, so Linux/macOS catch it.
check_build_script_watches() {
  if [ "$COVERAGE" = "1" ]; then
    # The instrumented build lives in llvm-cov's own target dir; the plain
    # `cargo test` legs already run this check.
    return
  fi
  if [ "${OS:-}" = "Windows_NT" ]; then
    cargo test "${selection[@]}" "${targets[@]}" --no-run
    return
  fi
  if ! command -v jq >/dev/null 2>&1; then
    if [ -n "${CI:-}" ]; then
      echo "check_build_script_watches: jq is required on CI" >&2
      exit 1
    fi
    echo "note: jq not found; skipping the build-script watch check (#3909)"
    cargo test "${selection[@]}" "${targets[@]}" --no-run
    return
  fi
  local plan
  plan="$(mktemp)"
  cargo test "${selection[@]}" "${targets[@]}" --no-run --message-format=json-render-diagnostics >"$plan"
  local missing=0 pkg_dir out_dir line path
  while IFS=$'\t' read -r pkg_dir out_dir; do
    [ -f "$out_dir/../output" ] || continue
    while IFS= read -r line; do
      path="${line#*rerun-if-changed=}"
      case "$path" in
        /*) ;;
        *) path="$pkg_dir/$path" ;;
      esac
      if [ ! -e "$path" ]; then
        echo "build script of ${pkg_dir} watches a missing path: ${line}" >&2
        missing=$((missing + 1))
      fi
    done < <(grep -E '^cargo::?rerun-if-changed=' "$out_dir/../output" || true)
  done < <(
    jq -r 'select(.reason == "build-script-executed")
      | select(.package_id | startswith("path+file://"))
      | [(.package_id | sub("^path\\+file://"; "") | sub("#.*$"; "")), .out_dir] | @tsv' "$plan"
  )
  rm -f "$plan"
  if [ "$missing" -ne 0 ]; then
    echo "A missing rerun-if-changed path re-runs its build script and recompiles the" >&2
    echo "crate on every cargo invocation (#3909). Watch a path that exists instead." >&2
    exit 1
  fi
}

# `cargo test -- --list` output reduced to sorted "<binary> <test>" lines, so
# identical test names in different binaries stay distinct.
list_libtest() {
  CARGO_TERM_COLOR=never LC_ALL=C cargo test "${selection[@]}" "${targets[@]}" -- --list --format terse "$@" 2>&1 |
    awk '/^ *Running /{bin=$NF} / (test|benchmark)$/{sub(/: (test|benchmark)$/, ""); print bin, $0}' |
    sed -E 's/-[0-9a-f]{16}(\.exe)?\)$/)/' |
    LC_ALL=C sort
}

# The same for nextest: sorted "<binary-id> <test>" lines, ignored tests
# included (libtest lists them too), with nextest's own filter matching.
list_nextest() {
  CARGO_TERM_COLOR=never LC_ALL=C cargo nextest list "${selection[@]}" "${targets[@]}" \
    --run-ignored all --message-format oneline -- "$@" |
    LC_ALL=C sort
}

# The ignored tests the given filters select (sorted "<binary-id> <test>").
list_nextest_ignored() {
  CARGO_TERM_COLOR=never LC_ALL=C cargo nextest list "${selection[@]}" "${targets[@]}" \
    --run-ignored only --message-format oneline -- "$@" |
    LC_ALL=C sort
}

# Partition with the runner the phases use, so `list` proves what CI runs.
list_tests() {
  if [ "$runner" = "nextest" ]; then
    list_nextest "$@"
  else
    list_libtest "$@"
  fi
}

# Every `#[serial(key)]` in the workspace needs a nextest test group of the same
# name with max-threads = 1, assigned by an override in .config/nextest.toml:
# nextest runs each test in its own process, where serial_test's in-process
# lock serializes nothing (#5345). A bare `#[serial]` has no name to map, so it
# is rejected too.
check_serial_groups() {
  local config=".config/nextest.toml" key missing=0 bare
  bare="$(git grep -nE '^[[:space:]]*#\[(serial_test::)?serial\]' -- '*.rs' ':!rdp-sidecar' || true)"
  if [ -n "$bare" ]; then
    echo "a bare #[serial] cannot map to a nextest test group; give it a key:" >&2
    echo "$bare" >&2
    missing=1
  fi
  while IFS= read -r key; do
    [ -n "$key" ] || continue
    if ! grep -qE "^${key} *= *\{ *max-threads *= *1 *\}" "$config" ||
      ! grep -qF "test-group = '${key}'" "$config"; then
      echo "#[serial(${key})] has no max-threads = 1 test group assigned in ${config}" >&2
      missing=1
    fi
  done < <(
    git grep -hoE '^[[:space:]]*#\[(serial_test::)?serial\([A-Za-z0-9_, ]+\)\]' -- '*.rs' ':!rdp-sidecar' |
      sed -E 's/.*serial\(([^)]*)\).*/\1/' | tr ',' '\n' | tr -d ' ' | LC_ALL=C sort -u
  )
  if [ "$missing" -ne 0 ]; then
    exit 1
  fi
  echo "serial groups: every #[serial(key)] has a nextest test group"
}

case "$phase" in
  bulk)
    echo "runner cores: $(cores); runner: ${runner}; bulk phase: default parallelism, skipping ${#HEAVY_FILTERS[@]} heavy filter(s)"
    if [ "$SPLIT_SERIAL" = "1" ]; then
      echo "  also skipping the serial set (runs in its own job): ${SERIAL_FILTERS[*]}"
    fi
    check_build_script_watches
    # A failed run still reaches the doc-tests (no fail-fast), then fails.
    status=0
    run_tests "" 0 "${skip_args[@]}" ${serial_skip_args[@]+"${serial_skip_args[@]}"} || status=$?
    if [ "$COVERAGE" = "1" ]; then
      echo "  doc-tests skipped (coverage run; see the header)"
    else
      cargo test "${selection[@]}" --all-features --doc || status=$?
    fi
    exit "$status"
    ;;
  heavy)
    echo "runner cores: $(cores); runner: ${runner}; heavy phase: --test-threads=${HEAVY_TEST_THREADS}"
    printf '  filter: %s\n' "${HEAVY_FILTERS[@]}"
    run_tests "$HEAVY_TEST_THREADS" 0 "${HEAVY_FILTERS[@]}" ${serial_skip_args[@]+"${serial_skip_args[@]}"}
    ;;
  serial)
    echo "runner cores: $(cores); runner: ${runner}; serial phase: --test-threads=1, expecting >= ${SERIAL_MIN_TESTS} test(s), deadline ${SERIAL_TIMEOUT_SECS}s"
    printf '  filter: %s\n' "${SERIAL_FILTERS[@]}"
    log="$(mktemp)"
    trap 'rm -f "$log"' EXIT
    # cargo writes to a FILE, never a pipe. The fresh-after-reconnect test
    # deliberately leaves a detached registry daemon behind (it models one that
    # outlives the agent), and on Windows every inheritable handle -- including
    # the write end of a `cargo | tee` pipe -- leaks into that grandchild. The
    # pipe then never reaches EOF: all 10 tests passed in 16s and the job still
    # hung until its 60-minute timeout (#3615, first run). A file has no EOF to
    # wait for, so we poll cargo itself and stream the log while it runs.
    set_run 1 1 "${SERIAL_FILTERS[@]}"
    "${run[@]}" >"$log" 2>&1 &
    cargo_pid=$!
    streamed=0
    stream_log() {
      local size
      size=$(wc -c <"$log" | tr -d ' ')
      if [ "$size" -gt "$streamed" ]; then
        tail -c +"$((streamed + 1))" "$log" | head -c "$((size - streamed))" || true
        streamed=$size
      fi
    }
    deadline=$((SECONDS + SERIAL_TIMEOUT_SECS))
    timed_out=0
    while kill -0 "$cargo_pid" 2>/dev/null; do
      stream_log
      if [ "$SECONDS" -ge "$deadline" ]; then
        timed_out=1
        break
      fi
      sleep 2
    done
    if [ "$timed_out" = "1" ]; then
      # Kill the whole tree (cargo -> test binary -> agent). Git Bash's `kill`
      # only reaches the top native process, so use taskkill /T there.
      if [ -r "/proc/$cargo_pid/winpid" ]; then
        taskkill //F //T //PID "$(cat "/proc/$cargo_pid/winpid")" >/dev/null 2>&1 || true
      fi
      kill "$cargo_pid" 2>/dev/null || true
    fi
    status=0
    wait "$cargo_pid" || status=$?
    keep_junit
    stream_log
    if [ "$timed_out" = "1" ]; then
      # The last "test NAME ..." line with no result after it is the wedged one.
      # (libtest: "test NAME ..."; nextest: "START [ ] (n/N) BINARY NAME").
      hung="$(plain_log "$log" | grep -oE '^test [^ ]+ \.\.\.|START .*' | tail -n 1 || true)"
      echo "serial phase: TIMED OUT after ${SERIAL_TIMEOUT_SECS}s (CI_SERIAL_TIMEOUT_SECS)." >&2
      echo "  last test started: ${hung:-<none -- still building?>}" >&2
      exit 124
    fi
    # Say so when a test leaked an agent process: harmless now that nothing waits
    # on a pipe, but a leak that starts accumulating should be visible.
    if [ "${OS:-}" = "Windows_NT" ]; then
      leaked="$(tasklist //FI "IMAGENAME eq termihub-agent.exe" //NH 2>/dev/null | grep -ci 'termihub-agent' || true)"
      if [ "${leaked:-0}" -gt 0 ]; then
        echo "serial phase: note: ${leaked} termihub-agent process(es) still running after cargo exited (leaked by a test)"
      fi
    fi
    # Count what ran. A guard, not a formality: a filter that silently matched
    # nothing would otherwise "pass" with zero tests run.
    if [ "$runner" = "nextest" ]; then
      # Nextest's one Summary line ("N tests run: P passed, F failed, ..."). It
      # never runs an ignored test (so it never reports one), so list them: the
      # ignored tests the serial filters select.
      read -r passed failed < <(
        plain_log "$log" | grep -E '^ *Summary \[' | tail -n 1 |
          awk '{for (i = 2; i <= NF; i++) {
              if ($i ~ /^passed/) p = $(i - 1)
              if ($i ~ /^failed/) f = $(i - 1)
            }}
            END {print p + 0, f + 0}'
      )
      ignored="$(list_nextest_ignored "${SERIAL_FILTERS[@]}" | wc -l | tr -d ' ')"
    else
      # Sum libtest's per-binary summaries.
      read -r passed failed ignored < <(
        plain_log "$log" |
          grep -oE 'test result: [A-Za-z]+\. [0-9]+ passed; [0-9]+ failed; [0-9]+ ignored' |
          awk '{p += $4; f += $6; i += $8} END {print p + 0, f + 0, i + 0}'
      )
    fi
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
    check_serial_groups
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT
    list_tests >"$tmp/all"
    if [ "$runner" = "nextest" ]; then
      # Nextest must find exactly the tests libtest lists (names, with
      # multiplicity), so moving to it dropped or added none.
      list_libtest | cut -d' ' -f2- | LC_ALL=C sort >"$tmp/libtest-names"
      cut -d' ' -f2- "$tmp/all" | LC_ALL=C sort >"$tmp/nextest-names"
      if ! cmp -s "$tmp/libtest-names" "$tmp/nextest-names"; then
        echo "nextest and libtest list different tests:" >&2
        diff "$tmp/libtest-names" "$tmp/nextest-names" >&2 || true
        exit 1
      fi
      echo "nextest lists the same $(wc -l <"$tmp/all" | tr -d ' ') tests as libtest"
    fi
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
