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

echo "Script parity OK: every scripts/**/*.sh <-> .cmd pair is present"
echo "(${#ALLOWLIST[@]} documented single-platform exception(s) skipped)."
