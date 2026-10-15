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
# Then (#4504, only when it builds the probe itself) it proves the offline
# symbolization the release debug-symbols assets exist for: it rebuilds the
# probe the way release.yml does (Linux: strip = none, then
# scripts/internal/debug-symbols.mjs splits the DWARF into a .debug file;
# macOS: packed split debuginfo -> .dSYM; Windows: strip = none so the MSVC
# linker writes a .pdb, which debug-symbols.mjs stages), runs the shipped-style
# binary AWAY from its symbols, checks the report's `image:` build id matches the
# symbol file, and resolves the CrashDetails::capture frame's address to
# crash_report.rs with addr2line (Linux), atos (macOS) or llvm-symbolizer
# against the .pdb (Windows) — the steps docs/contributing.md -> "Symbolizing a
# crash report" documents.
#
# Windows (#4794, Git Bash): a PE carries no symbol table, only the .pdb does,
# so a release report never names a frame and the first check is skipped. The
# probe runs with its .pdb moved away (dbghelp would otherwise find it through
# the absolute path the .exe records), the check requires its frames to read
# `<unknown>`, and every frame inside the probe's own module is symbolized
# (RVA = address - base, at the image's preferred base) until one resolves to
# CrashDetails::capture in crash_report.rs. It needs llvm-symbolizer on PATH or
# in C:\Program Files\LLVM\bin (preinstalled on GitHub's windows-latest).
#
# It also checks the report's `modules:` section (#4795): it must list a module
# marked `*` (holding a backtrace frame), and with split symbols that module must
# be the probe itself, at the `image:` base.
#
# Usage:
#   scripts/internal/check-release-crash-symbols.sh [<probe-binary>]
#   scripts/internal/check-release-crash-symbols.sh --help
#
# Exit status: 0 = resolved frame found (and symbolized offline), 1 = no
# resolved frame / no report / offline symbolization failed, 2 = usage. Runs per
# PR in agent.yml: job "Release crash-report symbols" on Ubuntu and job
# "Release crash-report symbols (Windows)" on windows-latest. A <probe-binary>
# argument is not supported on Windows (without its .pdb it names nothing).

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

case "$(uname -s)" in
Linux) os=linux ;;
Darwin) os=macos ;;
MINGW* | MSYS* | CYGWIN*) os=windows ;;
*) os=other ;;
esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
exe=""
if [ "$os" = windows ]; then
  if [ "$#" -eq 1 ]; then
    echo "::error::a Windows probe binary names no frame without its .pdb;" \
      "run this script without arguments" >&2
    exit 2
  fi
  # Mixed paths (D:/a/...) work in Git Bash and in native tools (cargo, node).
  REPO_ROOT="$(cygpath -m "$REPO_ROOT")"
  exe=".exe"
fi
target_dir="${CARGO_TARGET_DIR:-$REPO_ROOT/target}"

work="$(mktemp -d)"
[ "$os" != windows ] || work="$(cygpath -m "$work")"
# .pdb files moved away from the split build (Windows); restored on exit.
hidden=()
cleanup() {
  local f
  for f in ${hidden[@]+"${hidden[@]}"}; do
    mv -f "$f.away" "$f" 2>/dev/null || true
  done
  rm -rf "$work"
}
trap cleanup EXIT

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

if [ "$os" = windows ]; then
  echo "Release-profile symbol table check skipped on Windows: a PE has no symbol" \
    "table, so only the .pdb names frames (checked offline below)."
else
  if [ "$#" -eq 1 ]; then
    probe="$1"
  else
    echo "Building the crash probe with the release profile..."
    (cd "$REPO_ROOT" && cargo build --release --locked -p termihub-crash-probe)
    probe="$target_dir/release/termihub-crash-probe"
  fi
  if [ ! -x "$probe" ]; then
    echo "::error::crash probe binary not found or not executable: $probe" >&2
    exit 1
  fi

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
fi

# --- Offline symbolization with split debug symbols (#4504) ---------------
if [ "$#" -eq 1 ]; then
  exit 0
fi
case "$os" in
linux | windows) knobs=(CARGO_PROFILE_RELEASE_STRIP=none) ;;
macos) knobs=(CARGO_PROFILE_RELEASE_SPLIT_DEBUGINFO=packed) ;;
*)
  echo "Offline symbolization check skipped on $(uname -s)."
  exit 0
  ;;
esac

if [ "$os" = windows ]; then
  symbolizer="$(command -v llvm-symbolizer || true)"
  if [ -z "$symbolizer" ] && [ -x "/c/Program Files/LLVM/bin/llvm-symbolizer.exe" ]; then
    symbolizer="/c/Program Files/LLVM/bin/llvm-symbolizer.exe"
  fi
  if [ -z "$symbolizer" ]; then
    echo "::error::llvm-symbolizer not found; install LLVM (choco install llvm)" >&2
    exit 1
  fi
fi

echo "Building the crash probe with split debug symbols (${knobs[*]})..."
split_target="$target_dir/split-debug-symbols"
(cd "$REPO_ROOT" && env "${knobs[@]}" CARGO_TARGET_DIR="$split_target" \
  cargo build --release --locked -p termihub-crash-probe)
built="$split_target/release/termihub-crash-probe$exe"
node "$REPO_ROOT/scripts/internal/debug-symbols.mjs" stage --out "$work/symbols" "$built"
symbols="$(cut -f2 <<<"$(grep -v '^#' "$work/symbols/SYMBOLS.txt")")"
symbols="$work/symbols/$symbols"
if [ "$os" = windows ]; then
  # The .exe records its .pdb's absolute path, and dbghelp follows it; move
  # every copy cargo left (release/ and release/deps/) out of reach.
  while IFS= read -r pdb; do
    mv -f "$pdb" "$pdb.away"
    hidden+=("$pdb")
  done < <(find "$split_target/release" -maxdepth 2 -name 'termihub_crash_probe*.pdb')
  if [ "${#hidden[@]}" -eq 0 ]; then
    echo "::error::the split build left no termihub_crash_probe .pdb to move away" >&2
    exit 1
  fi
fi
# Run a copy that has no symbols next to it, like a shipped binary.
mkdir -p "$work/bin"
cp "$built" "$work/bin/termihub-crash-probe$exe"
split_report="$(run_probe "$work/bin/termihub-crash-probe$exe" "$work/split-reports")"
image="$(sed -n 's/^image: *//p' "$split_report")"
echo "image: $image"

if [ "$os" = windows ]; then
  echo "----- crash report (away from its .pdb) -----"
  cat "$split_report"
  echo "---------------------------------------------"
fi

base="$(sed -nE 's/^base (0x[0-9a-f]+),.*/\1/p' <<<"$image")"
if [ -z "$base" ]; then
  cat "$split_report" >&2
  echo "::error::the report lacks the image base (#4504)" >&2
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
*"pdb ${want_id%/*} age ${want_id##*/}") ;;
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
echo "OK: the report's image id matches the symbol file ($want_id)."

if [ "$os" = windows ]; then
  backtrace="$(sed -n '/^backtrace:$/,/^$/p' "$split_report")"
  if grep -q 'CrashDetails' <<<"$backtrace"; then
    echo "::error::the probe named its frames without its .pdb; it did not run away from it" >&2
    exit 1
  fi
  # Every frame address inside the probe's own module, as an RVA.
  size="$(awk '{ print $3 }' <<<"$own")"
  rvas=()
  while IFS= read -r addr; do
    if ((addr >= base && addr - base < size)); then
      rvas+=("$((addr - base))")
    fi
  done < <(grep -oE '^ *[0-9]+: +0x[0-9a-f]+' <<<"$backtrace" | grep -oE '0x[0-9a-f]+')
  if [ "${#rvas[@]}" -eq 0 ]; then
    echo "::error::no backtrace frame lies inside the probe's module at $base" >&2
    exit 1
  fi
  # llvm-symbolizer finds the .pdb next to the .exe and takes addresses at the
  # image's preferred base (PE optional header ImageBase).
  cp "$built" "$work/symbols/termihub-crash-probe.exe"
  preferred="$(node -e '
    const b = require("fs").readFileSync(process.argv[1]);
    const pe = b.readUInt32LE(0x3c);
    const opt = pe + 24;
    const base = b.readUInt16LE(opt) === 0x20b ? b.readBigUInt64LE(opt + 24) : BigInt(b.readUInt32LE(opt + 28));
    console.log("0x" + base.toString(16));
  ' "$work/symbols/termihub-crash-probe.exe")"
  echo "preferred image base: $preferred"
  addrs=()
  for rva in "${rvas[@]}"; do
    addrs+=("$(printf '0x%x' $((preferred + rva)))")
  done
  resolved="$(cd "$work/symbols" &&
    "$symbolizer" --obj=termihub-crash-probe.exe "${addrs[@]}" | tr -d '\r')"
  echo "symbolized ${#addrs[@]} frames (RVA = address - $base, + $preferred):"
  echo "$resolved"
  # A function line naming CrashDetails::capture, then its source location.
  if ! awk '/CrashDetails.*capture/ { hit = 1; next } hit && /crash_report\.rs/ { found = 1 } { hit = 0 }
    END { exit !found }' <<<"$resolved"; then
    echo "::error::offline symbolization did not resolve the CrashDetails::capture frame" \
      "to crash_report.rs with the .pdb" >&2
    exit 1
  fi
  echo "OK: the crash report symbolizes offline with the .pdb."
  exit 0
fi

frame="$(grep -E 'CrashDetails[^ ]*::capture' "$split_report" | head -n 1)"
addr="$(grep -oE '0x[0-9a-f]+' <<<"$frame" | head -n 1)"
if [ -z "$addr" ]; then
  cat "$split_report" >&2
  echo "::error::the report lacks the capture frame address (#4504)" >&2
  exit 1
fi

if [ "$os" = macos ]; then
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
