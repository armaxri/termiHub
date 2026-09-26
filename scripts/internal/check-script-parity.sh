#!/usr/bin/env bash
#
# Cross-platform script-parity gate (audit finding TOOL-012 / WA-CI-029).
#
# The repo ships paired entry points: a POSIX `scripts/<name>.sh` and a Windows
# `scripts/<name>.cmd` for the same task, so contributors on either OS get the
# same commands. Nothing enforced the pairing, so the two halves drifted -- a
# new `.sh` would ship with no `.cmd` counterpart (or vice-versa) and only a
# Windows (or Unix) user would discover the gap.
#
# This check fails when a tracked `scripts/**/*.sh` has no sibling `.cmd` (or a
# `.cmd` has no sibling `.sh`), minus the ALLOWLIST below of deliberately
# single-platform scripts. Add a new pair and it passes; add only one half and
# it fails until the other half (or an ALLOWLIST entry justifying the asymmetry)
# lands.
#
# Existence alone is not parity: build-agents.cmd once had both halves present
# while missing the .sh's --dev/--features/--sign-key flags and its .sha256
# sidecar (#3340). So for every pair the check ALSO compares the long options
# each half actually parses -- `--flag)` case labels / `[ "$1" = "--flag" ]`
# tests in the .sh, `"%~1"=="--flag"` tests in the .cmd -- and fails when one
# half accepts a flag the other does not. `--help` is exempt (spelled
# differently per platform). A .cmd that forwards all arguments to its .sh
# (`bash scripts/<name>.sh %*`) inherits the .sh's flags and is skipped. Known,
# tracked flag gaps live in FLAG_DRIFT_ALLOWLIST below.
#
# It is a pure filesystem/git check -- no build, no network -- and is wired into
# the `Shell Script Quality` CI job as a BLOCKING gate alongside shellcheck.
#
# Run it from anywhere:  scripts/internal/check-script-parity.sh

set -euo pipefail

# Resolve the repo root from this script's own location so it runs from any cwd.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"

# Deliberately single-platform scripts, each with the reason it has no twin.
# A path here is EXEMPT from the parity requirement -- keep the list minimal and
# justified; an unjustified entry defeats the whole check.
ALLOWLIST=(
  # Per-OS system-test orchestrators. Each targets one platform's toolchain
  # (Docker/socat/serial quirks); there is intentionally no single `.sh` or
  # `.cmd` that covers all three. `test-system.cmd` is the Windows dispatcher
  # that shells out to `test-system-windows.sh` via Git Bash / WSL.
  "scripts/test-system-linux.sh"     # Linux-only orchestrator (E2E lives here, ADR-5)
  "scripts/test-system-mac.sh"       # macOS-only orchestrator (no E2E under WKWebView)
  "scripts/test-system.cmd"          # Windows dispatcher -> test-system-windows.sh
  # Unix-only internal helpers -- invoked by other Unix tooling / CI / hooks,
  # never run standalone on Windows, so a `.cmd` twin would be dead weight.
  "scripts/internal/autoformat.sh"          # Claude Code PostToolUse hook (bash)
  "scripts/internal/dev-local-env.sh"       # sourced-only shell env resolver
  "scripts/internal/pnpm-audit-prod-gate.sh" # CI-only security gate (Ubuntu runner)
  "scripts/internal/screenshot-mockup.sh"   # headless-Chrome concept renderer
  "scripts/internal/check-script-parity.sh"   # this parity checker (CI-only bash gate)
  "scripts/internal/check-script-headless.sh" # headless-exec checker (CI-only bash gate)
  "scripts/internal/ci-rust-tests.sh"         # CI test runner (bash on every runner, CI-013)
  # Agent update signing (AGT-005, #3213): OpenSSL-3 pipelines run by release CI
  # on Ubuntu, and a one-time maintainer tool (Git Bash works on Windows).
  "scripts/internal/agent-update-signing.sh"     # CI-only sign/verify/check-key helper
  "scripts/internal/setup-agent-signing-key.sh"  # one-time maintainer key setup
)

in_allowlist() {
  local needle="$1" entry
  for entry in "${ALLOWLIST[@]}"; do
    [ "$entry" = "$needle" ] && return 0
  done
  return 1
}

missing=0
report_missing() {
  local have="$1" want="$2"
  echo "::error file=${have}::${have} has no counterpart ${want} (cross-platform parity, TOOL-012)"
  echo "  missing: ${want}"
  missing=$((missing + 1))
}

# Enumerate tracked scripts under scripts/ (any depth) by extension. `git
# ls-files -- scripts` walks the whole subtree; grep filters the extension. Only
# tracked files are considered, so a stray local script never trips the gate.
all_scripts="$(git ls-files -- scripts)"

# Every tracked shell script must have a matching .cmd (unless allowlisted).
while IFS= read -r sh; do
  [ -n "$sh" ] || continue
  in_allowlist "$sh" && continue
  cmd="${sh%.sh}.cmd"
  [ -f "$cmd" ] || report_missing "$sh" "$cmd"
done < <(printf '%s\n' "$all_scripts" | grep -E '\.sh$' || true)

# ...and vice-versa: every tracked .cmd must have a matching .sh.
while IFS= read -r cmd; do
  [ -n "$cmd" ] || continue
  in_allowlist "$cmd" && continue
  sh="${cmd%.cmd}.sh"
  [ -f "$sh" ] || report_missing "$cmd" "$sh"
done < <(printf '%s\n' "$all_scripts" | grep -E '\.cmd$' || true)

if [ "$missing" -gt 0 ]; then
  echo ""
  echo "Script parity check FAILED: ${missing} script(s) lack a cross-platform counterpart."
  echo "Add the missing .sh/.cmd, or -- if the script is genuinely single-platform --"
  echo "add it to ALLOWLIST in scripts/internal/check-script-parity.sh with a reason."
  exit 1
fi

# --- Flag parity -------------------------------------------------------------
#
# Known flag gaps, as "<script path without extension>|<flag>". Each entry must
# name the tracking issue; remove it when the gap is closed. An entry that no
# longer matches a real gap fails the check, so the list cannot rot.
FLAG_DRIFT_ALLOWLIST=(
  # build-rdp-sidecar.cmd lacks --target (cross-build) and --out (copy the
  # binary elsewhere); build.cmd only needs --release --tauri-externalbin.
  "scripts/build-rdp-sidecar|--out"    # #3475
  "scripts/build-rdp-sidecar|--target" # #3475
)

flag_drift_allowed() {
  local needle="$1" entry
  for entry in "${FLAG_DRIFT_ALLOWLIST[@]}"; do
    [ "$entry" = "$needle" ] && return 0
  done
  return 1
}

# Long options a .sh parses: `case` labels such as `--dev)` or `-h | --help)`,
# plus `[ "$1" = "--x" ]` / `[[ "${1:-}" == "--x" ]]` tests. Prints one per line.
sh_flags() {
  {
    grep -E '^[[:space:]]*(-{1,2}[A-Za-z][A-Za-z0-9-]*|"")([[:space:]]*\|[[:space:]]*(-{1,2}[A-Za-z][A-Za-z0-9-]*|""))*[[:space:]]*\)' "$1" || true
    grep -E '\[\[?[^]]*=[[:space:]]*"--[A-Za-z][A-Za-z0-9-]*"' "$1" || true
  } | { grep -oE -- '--[A-Za-z][A-Za-z0-9-]*' || true; } | { grep -vx -- '--help' || true; } | sort -u
}

# Long options a .cmd parses: `if [/i] "%~1"=="--x"` style comparisons.
cmd_flags() {
  { grep -oiE '=="--[A-Za-z][A-Za-z0-9-]*"' "$1" || true; } \
    | { grep -oE -- '--[A-Za-z][A-Za-z0-9-]*' || true; } | { grep -vx -- '--help' || true; } | sort -u
}

# True if the .cmd just forwards every argument to its .sh twin.
cmd_forwards_to_sh() {
  local cmd="$1" base
  base="$(basename "${cmd%.cmd}")"
  grep -qE "${base}\.sh\"?[[:space:]]+%\*" "$cmd"
}

drift=0
stale=0
checked=0
seen_allow=" " # space-separated allowlist entries that matched a real gap
while IFS= read -r sh; do
  [ -n "$sh" ] || continue
  cmd="${sh%.sh}.cmd"
  [ -f "$cmd" ] || continue
  cmd_forwards_to_sh "$cmd" && continue
  stem="${sh%.sh}"
  checked=$((checked + 1))
  sh_set="$(sh_flags "$sh")"
  cmd_set="$(cmd_flags "$cmd")"
  # comm needs sorted input (sh_flags/cmd_flags sort); -23 = only in first.
  while IFS= read -r flag; do
    [ -n "$flag" ] || continue
    if flag_drift_allowed "${stem}|${flag}"; then
      seen_allow="${seen_allow}${stem}|${flag} "
      continue
    fi
    echo "::error file=${cmd}::${cmd} does not accept ${flag}, which ${sh} does (flag parity, #3340)"
    drift=$((drift + 1))
  done < <(comm -23 <(printf '%s\n' "$sh_set") <(printf '%s\n' "$cmd_set"))
  while IFS= read -r flag; do
    [ -n "$flag" ] || continue
    if flag_drift_allowed "${stem}|${flag}"; then
      seen_allow="${seen_allow}${stem}|${flag} "
      continue
    fi
    echo "::error file=${sh}::${sh} does not accept ${flag}, which ${cmd} does (flag parity, #3340)"
    drift=$((drift + 1))
  done < <(comm -13 <(printf '%s\n' "$sh_set") <(printf '%s\n' "$cmd_set"))
done < <(printf '%s\n' "$all_scripts" | grep -E '\.sh$' || true)

for entry in "${FLAG_DRIFT_ALLOWLIST[@]}"; do
  if [[ "$seen_allow" != *" ${entry} "* ]]; then
    echo "::error file=scripts/internal/check-script-parity.sh::FLAG_DRIFT_ALLOWLIST entry '${entry}' matches no real gap -- remove it"
    stale=$((stale + 1))
  fi
done

if [ $((drift + stale)) -gt 0 ]; then
  echo ""
  echo "Script parity check FAILED: ${drift} flag mismatch(es), ${stale} stale allowlist entr(y/ies)."
  echo "Implement the flag in the other half, or -- if the gap is deliberate and"
  echo "tracked -- add \"<script stem>|<flag>\" to FLAG_DRIFT_ALLOWLIST with its issue."
  exit 1
fi

echo "Script parity OK: every scripts/**/*.sh <-> .cmd pair is present"
echo "(${#ALLOWLIST[@]} documented single-platform exception(s) skipped),"
echo "and ${checked} pair(s) accept the same flags (${#FLAG_DRIFT_ALLOWLIST[@]} tracked gap(s))."
