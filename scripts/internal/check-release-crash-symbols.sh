#!/usr/bin/env bash
#
# Prove a release-profile build writes a crash report whose backtrace names
# termiHub functions (#4316, audit OBS2-001).
#
# The desktop and agent panic hooks write a crash report with a std backtrace.
# std can only name a frame from the binary's own symbol table, so while the
# release profile used `strip = true` every frame of a shipped build's report
# read `<unknown>`. The profile now uses `strip = "debuginfo"`; this check keeps
# it that way.
#
# It builds tests/release-crash-probe with the workspace's real
# [profile.release] (or uses the binary given as $1), runs it — the probe
# installs a hook that calls the same CrashDetails::capture + write_report path
# as the real hooks, then panics — and fails unless the report's backtrace has a
# resolved `termihub_core::` frame.
#
# Then (#4504, only when it builds the probe itself, on Linux and macOS) it
# proves the offline symbolization the release debug-symbols assets exist for:
# it rebuilds the probe the way release.yml does (Linux: strip = none, then
# scripts/internal/debug-symbols.mjs splits the DWARF into a .debug file;
# macOS: packed split debuginfo -> .dSYM), runs the stripped binary AWAY from
# its symbols, checks the report's `image:` build id matches the symbol file,
# and resolves the CrashDetails::capture frame's address to crash_report.rs with
# addr2line (Linux) or atos (macOS) — the steps docs/contributing.md ->
# "Symbolizing a crash report" documents.
#
# It also checks the report's `modules:` section (#4795): it must list a module
# marked `*` (holding a backtrace frame), and with split symbols that module must
# be the probe itself, at the `image:` base. On macOS it must list dyld (#4806).
#
# Usage:
#   scripts/internal/check-release-crash-symbols.sh [<probe-binary>]
#   scripts/internal/check-release-crash-symbols.sh --help
#
# Exit status: 0 = resolved frame found (and symbolized offline), 1 = no
# resolved frame / no report / offline symbolization failed, 2 = usage. Runs per
# PR in agent.yml (job "Release crash-report symbols") on Ubuntu. Not meaningful
# on Windows: a PE carries no symbol table, only the .pdb does.

set -euo pipefail

usage() {
  sed -n '2,/^$/{s/^# \{0,1\}//;p;}' "${BASH_SOURCE[0]}"
}

case "${1:-}" in
  -h | --help)
    usage
    exit 0
    ;;
esac
if [ "$#" -gt 1 ]; then
  usage >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

if [ "$#" -eq 1 ]; then
  probe="$1"
else
  echo "Building the crash probe with the release profile..."
  (cd "$REPO_ROOT" && cargo build --release --locked -p termihub-crash-probe)
  target_dir="${CARGO_TARGET_DIR:-$REPO_ROOT/target}"
  probe="$target_dir/release/termihub-crash-probe"
fi
if [ ! -x "$probe" ]; then
  echo "::error::crash probe binary not found or not executable: $probe" >&2
  exit 1
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# Run probe binary $1 with crash-report dir $2; print the report's path.
run_probe() {
  # The probe panics on purpose; a zero exit means it did not.
  if "$1" "$2" 2>"$work/stderr.log"; then
    cat "$work/stderr.log" >&2
    echo "::error::the crash probe exited 0; it should have panicked" >&2
    return 1
  fi
  local reports=("$2"/crash-*.txt)
  if [ ! -f "${reports[0]}" ]; then
    cat "$work/stderr.log" >&2
    echo "::error::the crash probe wrote no crash report" >&2
    return 1
  fi
  printf '%s\n' "${reports[0]}"
}

report="$(run_probe "$probe" "$work/crash-reports")"

echo "----- crash report -----"
cat "$report"
echo "------------------------"

# The backtrace section: from the "backtrace:" line up to the first blank line.
# std's full format (#4504) prints crate disambiguators: `termihub_core[0123]::`.
backtrace="$(sed -n '/^backtrace:$/,/^$/p' "$report")"
if ! printf '%s\n' "$backtrace" | grep -Eq '[0-9]+: .*termihub_core(\[[0-9a-f]+\])?::'; then
  echo "::error::the release crash report has no resolved termihub_core frame;" \
    "is [profile.release] stripping the symbol table (strip = true)? See #4316." >&2
  exit 1
fi
echo "OK: the release crash report names termiHub functions."

# The modules section (#4795): from the "modules:" line up to the first blank line.
modules="$(sed -n '/^modules:/,/^$/p' "$report")"
if ! printf '%s\n' "$modules" | grep -Eq '^\* 0x[0-9a-f]+ 0x[0-9a-f]+ [^ ]+ '; then
  echo "::error::the crash report lists no loaded module holding a backtrace frame (#4795)" >&2
  exit 1
fi
echo "OK: the crash report lists the loaded modules."
# dyld is not in its own image list; the report adds it on macOS (#4806).
if [ "$(uname -s)" = "Darwin" ] &&
  ! printf '%s\n' "$modules" | grep -Eq '^[* ] 0x[0-9a-f]+ 0x[0-9a-f]+ dyld uuid '; then
  echo "::error::the macOS crash report does not list dyld among its modules (#4806)" >&2
  exit 1
fi

# --- Offline symbolization with split debug symbols (#4504) ---------------
if [ "$#" -eq 1 ]; then
  exit 0
fi
case "$(uname -s)" in
Linux) knobs=(CARGO_PROFILE_RELEASE_STRIP=none) ;;
Darwin) knobs=(CARGO_PROFILE_RELEASE_SPLIT_DEBUGINFO=packed) ;;
*)
  echo "Offline symbolization check skipped on $(uname -s)."
  exit 0
  ;;
esac

echo "Building the crash probe with split debug symbols (${knobs[*]})..."
split_target="$target_dir/split-debug-symbols"
(cd "$REPO_ROOT" && env "${knobs[@]}" CARGO_TARGET_DIR="$split_target" \
  cargo build --release --locked -p termihub-crash-probe)
built="$split_target/release/termihub-crash-probe"
node "$REPO_ROOT/scripts/internal/debug-symbols.mjs" stage --out "$work/symbols" "$built"
symbols="$(cut -f2 <<<"$(grep -v '^#' "$work/symbols/SYMBOLS.txt")")"
symbols="$work/symbols/$symbols"
# Run a copy that has no symbols next to it, like a shipped binary.
mkdir -p "$work/bin"
cp "$built" "$work/bin/termihub-crash-probe"
split_report="$(run_probe "$work/bin/termihub-crash-probe" "$work/split-reports")"
image="$(sed -n 's/^image: *//p' "$split_report")"
echo "image: $image"

frame="$(grep -E 'CrashDetails[^ ]*::capture' "$split_report" | head -n 1)"
addr="$(grep -oE '0x[0-9a-f]+' <<<"$frame" | head -n 1)"
base="$(sed -nE 's/^base (0x[0-9a-f]+),.*/\1/p' <<<"$image")"
if [ -z "$addr" ] || [ -z "$base" ]; then
  cat "$split_report" >&2
  echo "::error::the report lacks the image base or the capture frame address (#4504)" >&2
  exit 1
fi

own="$(sed -n '/^modules:/,/^$/p' "$split_report" | grep -E "^\* $base " || true)"
if [ -z "$own" ]; then
  echo "::error::the modules section does not mark the probe's image at $base (#4795)" >&2
  exit 1
fi
echo "module: $own"

want_id="$(node "$REPO_ROOT/scripts/internal/debug-symbols.mjs" id "$symbols" |
  sed -E 's/.*"id":"([^"]*)".*/\1/')"
case "$image" in
*"uuid $want_id"*) ;;
*"build-id "*)
  got_id="$(sed -E 's/.*build-id ([0-9a-f ]+).*/\1/; s/ //g' <<<"$image")"
  [ "$got_id" = "$want_id" ] || {
    echo "::error::report build-id $got_id != symbol file $want_id" >&2
    exit 1
  }
  ;;
*)
  echo "::error::the report's image line does not carry the symbols' id $want_id" >&2
  exit 1
  ;;
esac

if [ "$(uname -s)" = Darwin ]; then
  dwarf=("$symbols"/Contents/Resources/DWARF/*)
  resolved="$(atos -o "${dwarf[0]}" -l "$base" "$addr")"
else
  resolved="$(addr2line -f -C -e "$symbols" "$(printf '0x%x' $((addr - base)))")"
fi
echo "symbolized $addr (base $base): $resolved"
if ! grep -q 'crash_report\.rs' <<<"$resolved"; then
  echo "::error::offline symbolization did not resolve the capture frame to crash_report.rs" >&2
  exit 1
fi
echo "OK: the crash report symbolizes offline with the split debug symbols."
