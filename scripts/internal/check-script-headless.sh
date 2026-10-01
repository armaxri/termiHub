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
# A second section runs the agent update signing-key lifecycle for real in
# `--dry-run` / temp-file mode (#3329): initial setup, --rotate, --switch-over and
# `agent-update-signing.sh select-key`, all with THROWAWAY keys in a mktemp dir.
# It needs only OpenSSL 3, uploads nothing and never touches the repo key file.
#
# A third section runs build-agents.sh's REAL checksum sidecar writer
# (`write_checksum`) and its post-build gate (`verify_checksum_sidecars`) on a
# dummy binary (#1350, #4011): the function bodies are extracted from the script
# verbatim, so the code under test is the shipped code. It asserts the sidecar is
# the "<hex>  <name>" + LF format release.yml publishes, that `sha256sum -c`
# accepts it (and rejects it once the binary is tampered with), and that the
# gate counts a missing sidecar. The Windows .cmd twin is covered by the
# `Windows cmd Script Smoke` job (#4032).
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
  "scripts/internal/agent-update-signing.sh"
  "scripts/internal/apply-branch-protection.sh"
  "scripts/internal/build-system-test-app.sh"
  "scripts/internal/ci-rust-tests.sh"
  "scripts/internal/harness-coverage.sh"
  "scripts/internal/native-sshd-fixture.sh"
  "scripts/internal/run-native-sshd-suites.sh"
  "scripts/internal/setup-agent-signing-key.sh"
  "scripts/build-rdp-sidecar.sh"
  "scripts/ci-local.sh"
  "scripts/package-plugin.sh"
  "scripts/release-check.sh"
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

help_failures="$failures"

# --- Agent update signing-key lifecycle, dry-run (#3329) ---
# Every key below is generated for this run and destroyed with the temp dir.
SETUP="scripts/internal/setup-agent-signing-key.sh"
SIGNING="scripts/internal/agent-update-signing.sh"
REPO_KEY="agent/keys/update-signing.pub.pem"
LC="$(mktemp -d)"
trap 'rm -rf "$LC"' EXIT

lc_step() { # <description> <command...>: run, expect exit 0
  local desc="$1" out
  shift
  if out="$("$@" 2>&1)"; then
    echo "ok    signing lifecycle: ${desc}"
  else
    echo "::error::signing lifecycle: ${desc} failed (exit $?)"
    printf '%s\n' "$out" | sed 's/^/    | /'
    failures=$((failures + 1))
  fi
}
lc_refuse() { # <description> <command...>: run, expect a non-zero exit
  local desc="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    echo "::error::signing lifecycle: ${desc} succeeded but must be refused"
    failures=$((failures + 1))
  else
    echo "ok    signing lifecycle: ${desc} (refused)"
  fi
}
lc_blocks() { # <description> <file> <expected block count>
  local n
  n="$(grep -c -- '-----BEGIN PUBLIC KEY-----' "$2" || true)"
  if [ "$n" = "$3" ]; then
    echo "ok    signing lifecycle: ${1} (${n} key block(s))"
  else
    echo "::error::signing lifecycle: ${1}: expected $3 key block(s), found ${n}"
    failures=$((failures + 1))
  fi
}
# select_as <expected var> <pub file> <VAR=value...>: select-key must pick <var>.
select_as() {
  local want="$1" pub="$2" out
  shift 2
  if out="$(env "$@" bash "$SIGNING" --pub "$pub" select-key --out "$LC/chosen.pem" \
    AGENT_UPDATE_SIGNING_KEY AGENT_UPDATE_SIGNING_KEY_NEXT 2>&1)" &&
    grep -q "^Selected signing key: ${want} " <<<"$out" &&
    printf 'payload\n' >"$LC/bin" &&
    bash "$SIGNING" --pub "$pub" sign --key "$LC/chosen.pem" "$LC/bin" >/dev/null 2>&1; then
    echo "ok    signing lifecycle: select-key picks ${want} and it signs"
  else
    echo "::error::signing lifecycle: select-key should pick ${want}"
    printf '%s\n' "$out" | sed 's/^/    | /'
    failures=$((failures + 1))
  fi
}

repo_key_before="$(cat "$REPO_KEY")"

lc_step "initial setup --dry-run" bash "$SETUP" --dry-run --pub-file "$LC/pub.pem"
lc_step "--rotate --dry-run" bash "$SETUP" --rotate --dry-run --pub-file "$LC/pub.pem"
lc_blocks "after --rotate" "$LC/pub.pem" 2
lc_refuse "second --rotate while one is in progress" \
  bash "$SETUP" --rotate --dry-run --pub-file "$LC/pub.pem"
lc_step "--switch-over --dry-run" bash "$SETUP" --switch-over --dry-run --pub-file "$LC/pub.pem"
lc_blocks "after --switch-over" "$LC/pub.pem" 1
lc_refuse "--switch-over with no staged key" \
  bash "$SETUP" --switch-over --dry-run --pub-file "$LC/pub.pem"
if grep -q TERMIHUB-AGENT-UPDATE-KEY-PLACEHOLDER "$REPO_KEY"; then
  echo "skip  signing lifecycle: --rotate --dry-run on the repo key (still the placeholder)"
else
  lc_step "--rotate --dry-run on a copy of the repo key" bash "$SETUP" --rotate --dry-run
fi
if [ "$(cat "$REPO_KEY")" = "$repo_key_before" ]; then
  echo "ok    signing lifecycle: $REPO_KEY left untouched"
else
  echo "::error::signing lifecycle: a dry run modified $REPO_KEY"
  failures=$((failures + 1))
fi

# select-key across the overlap, with two throwaway keypairs standing in for the
# AGENT_UPDATE_SIGNING_KEY / _NEXT secrets.
for k in old new; do
  openssl genpkey -algorithm ed25519 -out "$LC/$k.pem" 2>/dev/null
  openssl pkey -in "$LC/$k.pem" -pubout -out "$LC/$k.pub"
done
cat "$LC/old.pub" "$LC/new.pub" >"$LC/overlap.pem"
cp "$LC/new.pub" "$LC/switched.pem"
OLD="$(cat "$LC/old.pem")"
NEW="$(cat "$LC/new.pem")"
select_as AGENT_UPDATE_SIGNING_KEY "$LC/overlap.pem" \
  "AGENT_UPDATE_SIGNING_KEY=$OLD" "AGENT_UPDATE_SIGNING_KEY_NEXT=$NEW"
select_as AGENT_UPDATE_SIGNING_KEY_NEXT "$LC/switched.pem" \
  "AGENT_UPDATE_SIGNING_KEY=$OLD" "AGENT_UPDATE_SIGNING_KEY_NEXT=$NEW"
lc_refuse "select-key during the overlap without the old key" \
  env -u AGENT_UPDATE_SIGNING_KEY "AGENT_UPDATE_SIGNING_KEY_NEXT=$NEW" \
  bash "$SIGNING" --pub "$LC/overlap.pem" select-key \
  AGENT_UPDATE_SIGNING_KEY AGENT_UPDATE_SIGNING_KEY_NEXT

lifecycle_failures=$((failures - help_failures))

# --- build-agents.sh checksum sidecar writer, on a dummy binary (#1350) ---
SC="$LC/sidecar"
mkdir -p "$SC/bin"
sc_ok() { echo "ok    checksum sidecar: $1"; }
sc_fail() {
  echo "::error file=scripts/build-agents.sh::checksum sidecar: $1"
  failures=$((failures + 1))
}
if command -v sha256sum >/dev/null 2>&1; then
  sha256_check() { sha256sum -c "$@"; }
  sha256_hex() { sha256sum | cut -c1-64; }
else
  sha256_check() { shasum -a 256 -c "$@"; }
  sha256_hex() { shasum -a 256 | cut -c1-64; }
fi
# Pull the two functions out of build-agents.sh verbatim (top-level `name() {`
# through the first column-0 `}`), so a change to them is what gets tested.
sc_funcs="$(sed -n -e '/^write_checksum() {$/,/^}$/p' \
  -e '/^verify_checksum_sidecars() {$/,/^}$/p' scripts/build-agents.sh)"
if ! grep -q '^write_checksum() {$' <<<"$sc_funcs" ||
  ! grep -q '^verify_checksum_sidecars() {$' <<<"$sc_funcs"; then
  sc_fail "write_checksum/verify_checksum_sidecars not found in scripts/build-agents.sh"
else
  eval "$sc_funcs"
  printf 'termihub agent checksum smoke\n' >"$SC/bin/termihub-agent"
  # Called with a path from another directory, as the build loop does.
  if write_checksum "$SC/bin/termihub-agent"; then
    sc_ok "write_checksum exited 0"
  else
    sc_fail "write_checksum failed on a dummy binary"
  fi
  hex="$(sha256_hex <"$SC/bin/termihub-agent")"
  printf '%s  %s\n' "$hex" termihub-agent >"$SC/expected.sha256"
  if cmp -s "$SC/expected.sha256" "$SC/bin/termihub-agent.sha256"; then
    sc_ok "sidecar is '<hex>  <name>' + LF (the release.yml format)"
  else
    sc_fail "sidecar bytes differ from '<hex>  termihub-agent' + LF"
    od -c "$SC/bin/termihub-agent.sha256" 2>&1 | sed 's/^/    | /' || true
  fi
  if (cd "$SC/bin" && sha256_check termihub-agent.sha256 >/dev/null 2>&1); then
    sc_ok "sha256sum -c accepts the sidecar"
  else
    sc_fail "sha256sum -c rejected the sidecar build-agents.sh wrote"
  fi
  if verify_checksum_sidecars "$SC/bin/termihub-agent" 2>/dev/null; then
    sc_ok "verify_checksum_sidecars passes a binary with a sidecar"
  else
    sc_fail "verify_checksum_sidecars rejected a binary that has a sidecar"
  fi
  printf 'no sidecar\n' >"$SC/bin/other-agent"
  rc=0
  verify_checksum_sidecars "$SC/bin/termihub-agent" "$SC/bin/other-agent" 2>/dev/null || rc=$?
  if [ "$rc" -eq 1 ]; then
    sc_ok "verify_checksum_sidecars counts 1 missing sidecar"
  else
    sc_fail "verify_checksum_sidecars returned $rc for 1 missing sidecar (want 1)"
  fi
  printf 'tampered\n' >>"$SC/bin/termihub-agent"
  if (cd "$SC/bin" && sha256_check termihub-agent.sha256 >/dev/null 2>&1); then
    sc_fail "sha256sum -c accepted the sidecar for a tampered binary"
  else
    sc_ok "sha256sum -c rejects a tampered binary"
  fi
  # A sidecar that cannot be written must fail the target (WA-CI-036). Root
  # ignores directory permissions, so this check only means something non-root.
  if [ "$(id -u)" -ne 0 ]; then
    mkdir -p "$SC/ro"
    printf 'x\n' >"$SC/ro/termihub-agent"
    chmod a-w "$SC/ro"
    if write_checksum "$SC/ro/termihub-agent" 2>/dev/null; then
      sc_fail "write_checksum returned 0 although the sidecar could not be written"
    else
      sc_ok "write_checksum fails when the sidecar cannot be written"
    fi
    chmod u+w "$SC/ro"
  else
    echo "skip  checksum sidecar: unwritable-directory check (running as root)"
  fi
fi

echo ""
if [ "$failures" -gt 0 ]; then
  echo "Headless script smoke FAILED: ${help_failures} --help path(s) errored," \
    "${lifecycle_failures} signing-lifecycle check(s) failed," \
    "$((failures - help_failures - lifecycle_failures)) checksum-sidecar check(s) failed."
  exit 1
fi
echo "Headless script smoke OK: ${#SCRIPTS[@]} script(s) executed their --help path cleanly;" \
  "the signing-key dry-run lifecycle and the checksum sidecar writer passed."
