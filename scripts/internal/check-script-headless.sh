#!/usr/bin/env bash
#
# Headless shell-script smoke gate (audit finding TOOL-012 / WA-CI-029).
#
# Static analysis (`bash -n` and the ShellCheck linter) only PARSES a script; it
# never runs it, so it cannot see a runtime `set -u` / expansion fault -- exactly the class that
# broke verify-agent-reconnect.sh on its first real run (a `set -u` script whose
# heredoc arithmetic-expanded an unbound variable; shellcheck flagged it SC2257
# and it was suppressed as a false positive, with no CI ever executing it).
#
# This gate actually EXECUTES each script's `--help` path. That runs the real
# thing -- shebang, `set -euo pipefail`, any top-of-file sourcing (the four
# test-system scripts source scripts/internal/dev-local-env.sh before parsing
# args), and the argument parser up to the help branch -- and asserts a clean
# exit 0. A `set -u` unbound-variable fault, a bad expansion, or a
# command-not-found anywhere on that path fails the gate. This is a real run,
# not a `bash -n` parse, which is the entire point of the finding.
#
# Scope is deliberately the `--help` fast path: it is non-destructive, needs no
# network / Docker / app build, and is deterministic (not flaky). Scripts whose
# only entry points do real build/test/launch work (build.sh, dev.sh, test.sh,
# format.sh, clean.sh, ...) expose no safe headless path and are covered by the
# ShellCheck lane instead; do NOT add them here. To include a new script, give
# it a safe `--help` early-exit and add it to SCRIPTS below.
#
# Wired into the `Shell Script Quality` CI job. Run it from anywhere:
#   scripts/internal/check-script-headless.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"

# Scripts with a safe, non-destructive `--help` early-exit. Each is executed
# with `--help` and must exit 0. Keep this in sync with the scripts that
# actually implement a help branch (check with: grep -l -- '--help' scripts/*.sh).
SCRIPTS=(
  "scripts/build-agents.sh"
  "scripts/build-rdp-sidecar.sh"
  "scripts/ci-local.sh"
  "scripts/package-plugin.sh"
  "scripts/setup-agent-cross.sh"
  "scripts/smoke-test.sh"
  "scripts/test-system-linux.sh"
  "scripts/test-system-mac.sh"
  "scripts/test-system-py.sh"
  "scripts/test-system-windows.sh"
)

failures=0
for script in "${SCRIPTS[@]}"; do
  if [ ! -f "$script" ]; then
    echo "::error file=${script}::listed in check-script-headless.sh but not found"
    failures=$((failures + 1))
    continue
  fi

  # Real execution of the --help path (respects the script's own set flags).
  if output="$(bash "$script" --help 2>&1)"; then
    echo "ok    ${script} --help (exit 0)"
  else
    rc=$?
    echo "::error file=${script}::${script} --help failed with exit ${rc} (runtime fault static checks miss, TOOL-012)"
    printf '%s\n' "$output" | sed 's/^/    | /'
    failures=$((failures + 1))
  fi
done

echo ""
if [ "$failures" -gt 0 ]; then
  echo "Headless script smoke FAILED: ${failures} script(s) errored on their --help path."
  exit 1
fi
echo "Headless script smoke OK: ${#SCRIPTS[@]} script(s) executed their --help path cleanly."
