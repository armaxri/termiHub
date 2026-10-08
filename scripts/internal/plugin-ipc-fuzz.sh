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
#       found a crash, leak, timeout or OOM. libFuzzer writes the reproducer to plugin-runner/fuzz/artifacts/<target>/.
#       Reproduce one with:
#         (cd plugin-runner && cargo +nightly fuzz run <target> <artifact>)
#
# Needs a nightly toolchain and cargo-fuzz:
#   rustup toolchain install nightly --profile minimal
#   cargo install cargo-fuzz --locked
set -euo pipefail

usage() {
  sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'
}

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

cd "$(git rev-parse --show-toplevel)/plugin-runner"
CORPUS="$PWD/fuzz/corpus"

if ! cargo +nightly fuzz --version >/dev/null 2>&1; then
  echo "cargo-fuzz on a nightly toolchain is required (see --help)" >&2
  exit 2
fi

echo "== regenerating the seed corpus"
(cd fuzz && cargo +nightly run --quiet --bin gen-seeds -- "$CORPUS")

status=0
for target in "${TARGETS[@]}"; do
  echo "== fuzzing $target for ${SECONDS_PER_TARGET}s"
  # -timeout: one input taking >10 s is a hang. -rss_limit_mb: a frame is
  # capped at 1 MiB, so 2 GiB of RSS means an unbounded allocation.
  if ! cargo +nightly fuzz run "$target" "$CORPUS/$target" -- \
    -max_total_time="$SECONDS_PER_TARGET" -timeout=10 -rss_limit_mb=2048 \
    -print_final_stats=1; then
    echo "::error::fuzz target $target failed; reproducer under plugin-runner/fuzz/artifacts/$target/"
    status=1
  fi
done
exit "$status"
