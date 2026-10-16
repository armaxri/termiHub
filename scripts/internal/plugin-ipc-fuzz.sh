#!/usr/bin/env bash
# Short fuzz run over the plugin IPC frame protocol (#4190, plugin OS-sandbox
# phase 8). The nightly `plugin-sandbox-nightly.yml` lane runs it, and it works
# the same locally. It lives in the checked-out tree, not in the workflow, so a
# scheduled run (which uses main's workflow file) still runs develop's recipe.
#
# Targets (plugin-runner/fuzz/fuzz_targets/):
#   host_decode      the host decoding runner frames (the untrusted direction)
#   runner_decode    the runner decoding host frames
#   frame_roundtrip  well-formed messages survive encode -> short reads -> decode
#
# Usage:
#   scripts/internal/plugin-ipc-fuzz.sh [--seconds <n>] [--target <name>]...
#       Regenerate the seed corpus from the real encoder (gen-seeds), then run
#       each target for <n> seconds (default 60) on its corpus under
#       plugin-runner/fuzz/corpus/<target> (kept between runs; the nightly lane
#       caches it). Every target runs; the script exits non-zero if any of them
#       found a crash, leak, timeout or OOM. libFuzzer writes the reproducer
#       to plugin-runner/fuzz/artifacts/<target>/.
#       Reproduce one with:
#         (cd plugin-runner && cargo +<pinned-nightly> fuzz run <target> <artifact>)
#
#   scripts/internal/plugin-ipc-fuzz.sh --print-toolchain
#       Print the pinned nightly toolchain and exit (CI installs it with this).
#
# Needs the pinned nightly (plugin-runner/fuzz/nightly-toolchain; libFuzzer's
# sanitizer flags are nightly-only, and a dated pin keeps CI reproducible, the
# CI-005 rule) and cargo-fuzz:
#   rustup toolchain install "$(scripts/internal/plugin-ipc-fuzz.sh --print-toolchain)" \
#     --profile minimal
#   cargo install cargo-fuzz --locked
# FUZZ_TOOLCHAIN=<toolchain> overrides the pin (e.g. FUZZ_TOOLCHAIN=nightly).
#
# The fuzz build targets the toolchain's own host triple, passed to cargo-fuzz
# explicitly: cargo-fuzz otherwise defaults --target to the triple IT was built
# for, and the prebuilt Linux binary CI installs is the musl one, whose static
# libc ASan refuses (#4825). FUZZ_TARGET_TRIPLE=<triple> overrides it.
#
# Every target is built before any is fuzzed. A build failure exits non-zero
# with the build error and is never reported as a fuzz finding.
set -euo pipefail

usage() {
  sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'
}

FUZZ_DIR="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)/plugin-runner/fuzz"
TOOLCHAIN="${FUZZ_TOOLCHAIN:-$(tr -d '[:space:]' <"$FUZZ_DIR/nightly-toolchain")}"
SECONDS_PER_TARGET=60
TARGETS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --seconds)
      SECONDS_PER_TARGET="${2:?--seconds needs a value}"
      shift 2
      ;;
    --target)
      TARGETS+=("${2:?--target needs a value}")
      shift 2
      ;;
    --print-toolchain)
      echo "$TOOLCHAIN"
      exit 0
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done
if [ ${#TARGETS[@]} -eq 0 ]; then
  TARGETS=(host_decode runner_decode frame_roundtrip)
fi
if ! [[ "$SECONDS_PER_TARGET" =~ ^[1-9][0-9]*$ ]]; then
  echo "--seconds must be a positive integer, got '$SECONDS_PER_TARGET'" >&2
  exit 2
fi

cd "$FUZZ_DIR/.."
CORPUS="$FUZZ_DIR/corpus"

if ! cargo "+$TOOLCHAIN" fuzz --version >/dev/null 2>&1; then
  echo "cargo-fuzz on the $TOOLCHAIN toolchain is required (see --help)" >&2
  exit 2
fi

TRIPLE="${FUZZ_TARGET_TRIPLE:-$(rustc "+$TOOLCHAIN" -vV | sed -n 's/^host: //p')}"
if [ -z "$TRIPLE" ]; then
  echo "could not read the host triple of the $TOOLCHAIN toolchain" >&2
  exit 2
fi

echo "== regenerating the seed corpus"
(cd fuzz && cargo "+$TOOLCHAIN" run --quiet --bin gen-seeds -- "$CORPUS")

# Build first, so a broken build fails loudly as a build failure and is not
# reported as a crash with a reproducer that does not exist.
for target in "${TARGETS[@]}"; do
  echo "== building $target for $TRIPLE"
  if ! cargo "+$TOOLCHAIN" fuzz build --target "$TRIPLE" "$target"; then
    echo "::error::fuzz target $target failed to BUILD for $TRIPLE (no fuzzing ran; see the build error above)"
    exit 1
  fi
done

# Files under a target's artifact directory (0 before libFuzzer creates it).
artifact_count() {
  if [ -d "$1" ]; then
    find "$1" -type f | wc -l | tr -d ' '
  else
    echo 0
  fi
}

status=0
for target in "${TARGETS[@]}"; do
  echo "== fuzzing $target for ${SECONDS_PER_TARGET}s"
  artifacts="$FUZZ_DIR/artifacts/$target"
  before="$(artifact_count "$artifacts")"
  # -timeout: one input taking >10 s is a hang. -rss_limit_mb: a frame is
  # capped at 1 MiB, so 2 GiB of RSS means an unbounded allocation.
  if ! cargo "+$TOOLCHAIN" fuzz run --target "$TRIPLE" "$target" "$CORPUS/$target" -- \
    -max_total_time="$SECONDS_PER_TARGET" -timeout=10 -rss_limit_mb=2048 \
    -print_final_stats=1; then
    after="$(artifact_count "$artifacts")"
    if [ "$after" -gt "$before" ]; then
      echo "::error::fuzz target $target found a crash; reproducer under plugin-runner/fuzz/artifacts/$target/"
    else
      echo "::error::fuzz target $target failed without writing a reproducer (see the output above)"
    fi
    status=1
  fi
done
exit "$status"
