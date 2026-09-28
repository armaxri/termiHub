#!/usr/bin/env bash
# Coverage for the Python bridge system-test harness (TOOL-005 follow-up, #3657).
#
# The nightly system-integration workflow's Linux leg uses this, and it works the
# same locally. It lives in the checked-out tree, not in the workflow, for the
# same reason as build-system-test-app.sh: a scheduled run uses main's workflow
# file but builds develop, so a recipe copied into the workflow drifts (#3664).
#
# Usage:
#   scripts/internal/harness-coverage.sh env [--dir <dir>] [--github-env]
#       Print KEY=VALUE lines that switch coverage on for the build AND the test
#       run: TERMIHUB_FRONTEND_COVERAGE=1 (Istanbul-instrumented frontend,
#       scripts/internal/vite-coverage-plugin.mjs), TERMIHUB_HARNESS_COVERAGE_DIR
#       (where the harness writes its dumps, tests/system/termihub_harness/
#       coverage.py), and, when cargo-llvm-cov is installed, the
#       `cargo llvm-cov show-env` variables (instrumented workspace crates plus
#       LLVM_PROFILE_FILE). Without cargo-llvm-cov only the frontend is measured.
#       --github-env appends the lines to $GITHUB_ENV instead of printing them.
#       Locally: set -a; eval "$(scripts/internal/harness-coverage.sh env)"; set +a
#       Then build with build-system-test-app.sh and run the harness as usual.
#
#   scripts/internal/harness-coverage.sh report --out-dir <dir> [--branch <name>]
#       After the run: convert the frontend dumps to lcov
#       (istanbul-to-lcov.mjs), export the backend profiles with
#       `cargo llvm-cov report` (llvm-cov-report.mjs drops a truncated profile),
#       and write <dir>/harness.lcov (both concatenated; they share no file) plus
#       <dir>/harness-coverage.json ({sha, branch, frontend, rust}). The sha is
#       the commit that was MEASURED, which fetch-integration-coverage.mjs needs:
#       a scheduled run's metadata names main even when it built develop.
#       Needs the `env` variables in its environment.
#
# ADVISORY: `report` exits 0 whenever it can write anything; a missing half is
# a note in its output, never a failure of the lane.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

DEFAULT_DIR="$PWD/target/harness-coverage"

usage() {
    awk 'NR==1{next} /^#/{sub(/^# ?/,""); print; next} {exit}' "$0"
}

cmd_env() {
    local dir="$DEFAULT_DIR" github_env=0
    while [ "$#" -gt 0 ]; do
        case "$1" in
        --dir) dir="$2"; shift ;;
        --github-env) github_env=1 ;;
        *) echo "unknown argument: $1" >&2; exit 2 ;;
        esac
        shift
    done
    local lines=("TERMIHUB_FRONTEND_COVERAGE=1" "TERMIHUB_HARNESS_COVERAGE_DIR=$dir")
    if cargo llvm-cov --version >/dev/null 2>&1; then
        local names name
        names="$(cargo llvm-cov show-env 2>/dev/null | sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p')"
        eval "$(cargo llvm-cov show-env --sh 2>/dev/null)"
        for name in $names; do
            lines+=("$name=${!name}")
        done
        # Profiles from an earlier run would be merged into this one's report.
        rm -f "${CARGO_LLVM_COV_TARGET_DIR:-target}"/*.profraw
    else
        echo "note: cargo-llvm-cov not installed; measuring the frontend only" >&2
    fi
    if [ "$github_env" -eq 1 ]; then
        printf '%s\n' "${lines[@]}" >> "${GITHUB_ENV:?--github-env needs GITHUB_ENV}"
    else
        printf '%s\n' "${lines[@]}"
    fi
}

cmd_report() {
    local out="" branch=""
    while [ "$#" -gt 0 ]; do
        case "$1" in
        --out-dir) out="$2"; shift ;;
        --branch) branch="$2"; shift ;;
        *) echo "unknown argument: $1" >&2; exit 2 ;;
        esac
        shift
    done
    [ -n "$out" ] || { echo "report needs --out-dir" >&2; exit 2; }
    mkdir -p "$out"
    local dumps="${TERMIHUB_HARNESS_COVERAGE_DIR:-$DEFAULT_DIR}/frontend"
    local frontend=0 rust=0
    rm -f "$out/frontend.lcov" "$out/rust.lcov" "$out/harness.lcov"

    node scripts/internal/istanbul-to-lcov.mjs --in-dir "$dumps" \
        --out "$out/frontend.lcov" --root "$PWD" || true
    [ -s "$out/frontend.lcov" ] && frontend=1

    if [ -n "${CARGO_LLVM_COV:-}" ]; then
        if node scripts/internal/llvm-cov-report.mjs "$out/rust.lcov"; then
            [ -s "$out/rust.lcov" ] && rust=1
        else
            echo "note: cargo llvm-cov report failed; no backend coverage" >&2
        fi
    else
        echo "note: not built under cargo llvm-cov show-env; no backend coverage" >&2
    fi

    : > "$out/harness.lcov"
    [ "$frontend" -eq 1 ] && cat "$out/frontend.lcov" >> "$out/harness.lcov"
    [ "$rust" -eq 1 ] && cat "$out/rust.lcov" >> "$out/harness.lcov"

    local sha
    sha="$(git rev-parse HEAD)"
    printf '{"sha":"%s","branch":"%s","frontend":%s,"rust":%s}\n' \
        "$sha" "$branch" "$([ "$frontend" -eq 1 ] && echo true || echo false)" \
        "$([ "$rust" -eq 1 ] && echo true || echo false)" > "$out/harness-coverage.json"

    echo "harness coverage: frontend=$frontend rust=$rust sha=$sha"
    if [ -s "$out/harness.lcov" ]; then
        node scripts/internal/lcov-summary.mjs "$out/harness.lcov"
    else
        rm -f "$out/harness.lcov"
        echo "note: no harness coverage was produced" >&2
    fi
}

case "${1:-}" in
env) shift; cmd_env "$@" ;;
report) shift; cmd_report "$@" ;;
-h | --help | "") usage ;;
*) echo "unknown command: $1 (see --help)" >&2; exit 2 ;;
esac
