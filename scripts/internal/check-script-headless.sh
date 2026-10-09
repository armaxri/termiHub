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
# The same section runs the plugin-index signing key setup (#3716) in --dry-run
# and proves a signed index verifies, a tampered one and a foreign key do not,
# and that the repo key file and plugins/index.json are left untouched.
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
# A fourth section runs release-smoke-app-lifecycle.sh (the release install-smoke's
# app-log + single-instance checks, #4011) end to end against a STUB app: a small
# bash script that writes the real app's log lines, holds a single-instance lock
# and logs a clean exit on SIGTERM. The smoke must pass on the faithful stub and
# FAIL on stubs that skip the clean-exit line or let a second instance keep
# running, so the gate is proven to bite before a release ever depends on it.
#
# A fifth section runs assert-no-test-bridge.sh (#4122) on dummy binaries: it
# must pass one without the test-bridge build marker and fail on one with it.
#
# The same section runs verify-plugin-runner-bundle.sh (#4202) on a stub app and
# runner: it must pass a runner that answers with its usage code and whose
# SHA-256 the app embeds, and fail a missing, mis-answering or unembedded one.
#
# A sixth section runs test-verify-bundle-scripts.ps1 (#4207) where pwsh is
# installed: the Windows bundle checks verify-conpty-bundle.ps1 and
# verify-no-vcruntime.ps1, run verbatim behind the workflow's
# `if ($LASTEXITCODE -ne 0) { exit 1 }` guard in a fresh pwsh, must exit 0 when
# they pass (also after a native command exited non-zero) and 1 when they fail.
#
# Next to it, verify-rdp-helper-bundle.sh (#4222) runs on a stub app and helper:
# it must pass a helper whose SHA-256 the app embeds and fail a rewritten (e.g.
# re-signed), missing or unembedded one. Its failures count as bundle checks.
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
  "scripts/internal/assert-no-test-bridge.sh"
  "scripts/internal/build-system-test-agent.sh"
  "scripts/internal/build-system-test-app.sh"
  "scripts/internal/check-release-crash-symbols.sh"
  "scripts/internal/ci-rust-tests.sh"
  "scripts/internal/fetch-conpty.sh"
  "scripts/internal/harness-coverage.sh"
  "scripts/internal/native-sshd-fixture.sh"
  "scripts/internal/plugin-index-signing.sh"
  "scripts/internal/plugin-ipc-fuzz.sh"
  "scripts/internal/release-smoke-app-lifecycle.sh"
  "scripts/internal/run-native-sshd-suites.sh"
  "scripts/internal/setup-agent-signing-key.sh"
  "scripts/internal/setup-plugin-index-signing-key.sh"
  "scripts/internal/setup-plugin-publisher-key.sh"
  "scripts/internal/shell-integration-cli-smoke.sh"
  "scripts/internal/verify-plugin-runner-bundle.sh"
  "scripts/internal/verify-rdp-helper-bundle.sh"
  "scripts/build-rdp-sidecar.sh"
  "scripts/build-plugin-runner.sh"
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

# --- Plugin-index signing key setup, dry-run (#3716) ---
PI_SETUP="scripts/internal/setup-plugin-index-signing-key.sh"
PI_SIGNING="scripts/internal/plugin-index-signing.sh"
PI_REPO_KEY="plugins/keys/index-signing.pub.pem"
PI_INDEX="plugins/index.json"
pi_key_before="$(cat "$PI_REPO_KEY")"
pi_index_before="$(cat "$PI_INDEX")"
pi_sig_before="$(cat "$PI_INDEX.sig" 2>/dev/null || true)"
mkdir -p "$LC/pi"
printf '{"schemaVersion":1,"plugins":[]}\n' >"$LC/pi/index.json"
lc_step "plugin index: setup --dry-run on the repo index (temp copies)" bash "$PI_SETUP" --dry-run
lc_step "plugin index: setup --dry-run signs a given index" \
  bash "$PI_SETUP" --dry-run --pub-file "$LC/pi/pub.pem" --index "$LC/pi/index.json"
lc_refuse "plugin index: setup over a real key without --force" \
  bash "$PI_SETUP" --dry-run --pub-file "$LC/pi/pub.pem" --index "$LC/pi/index.json"
# The dry run signed a temp COPY of the given index; sign the original for real
# with a throwaway key to exercise sign/verify end to end.
openssl genpkey -algorithm ed25519 -out "$LC/pi/k.pem" 2>/dev/null
openssl pkey -in "$LC/pi/k.pem" -pubout -out "$LC/pi/k.pub"
lc_step "plugin index: sign + verify" \
  bash "$PI_SIGNING" --pub "$LC/pi/k.pub" sign --key "$LC/pi/k.pem" "$LC/pi/index.json"
printf ' ' >>"$LC/pi/index.json"
lc_refuse "plugin index: verify a tampered index" \
  bash "$PI_SIGNING" --pub "$LC/pi/k.pub" verify "$LC/pi/index.json"
lc_refuse "plugin index: sign with a key that is not trusted" \
  bash "$PI_SIGNING" --pub "$LC/pi/pub.pem" sign --key "$LC/pi/k.pem" "$LC/pi/index.json"
if [ "$(cat "$PI_REPO_KEY")" = "$pi_key_before" ] &&
  [ "$(cat "$PI_INDEX")" = "$pi_index_before" ] &&
  [ "$(cat "$PI_INDEX.sig" 2>/dev/null || true)" = "$pi_sig_before" ]; then
  echo "ok    signing lifecycle: $PI_REPO_KEY and $PI_INDEX left untouched"
else
  echo "::error::signing lifecycle: a plugin-index dry run modified the repo tree"
  failures=$((failures + 1))
fi

# --- First-party plugin publisher key setup, dry-run (#3980) ---
FP_SETUP="scripts/internal/setup-plugin-publisher-key.sh"
FP_REPO_KEY="plugins/keys/first-party-publisher.pub.pem"
fp_key_before="$(cat "$FP_REPO_KEY")"
mkdir -p "$LC/fp"
lc_step "first-party publisher: setup --dry-run (temp key file)" bash "$FP_SETUP" --dry-run
lc_step "first-party publisher: setup --dry-run writes a given key file" \
  bash "$FP_SETUP" --dry-run --pub-file "$LC/fp/pub.pem"
if grep -q -- "-----BEGIN PUBLIC KEY-----" "$LC/fp/pub.pem" &&
  ! grep -q "PRIVATE KEY" "$LC/fp/pub.pem"; then
  echo "ok    signing lifecycle: first-party key file holds only a public key"
else
  echo "::error::signing lifecycle: first-party key file is missing its public key or leaks private material"
  failures=$((failures + 1))
fi
lc_refuse "first-party publisher: setup over a real key without --force" \
  bash "$FP_SETUP" --dry-run --pub-file "$LC/fp/pub.pem"
lc_step "first-party publisher: setup --force over a real key" \
  bash "$FP_SETUP" --dry-run --force --pub-file "$LC/fp/pub.pem"
if [ "$(cat "$FP_REPO_KEY")" = "$fp_key_before" ]; then
  echo "ok    signing lifecycle: $FP_REPO_KEY left untouched"
else
  echo "::error::signing lifecycle: a first-party publisher dry run modified the repo tree"
  failures=$((failures + 1))
fi

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

sidecar_and_earlier_failures="$failures"

# --- release-smoke-app-lifecycle.sh against a stub app (#4011) ---
LS="$LC/lifecycle"
mkdir -p "$LS"
# The stub mimics the installed app's observable contract: the startup banner,
# the frontend IPC marker, the single-instance lock (a second launch hands its
# --workspace / --workspace-file over and exits) and the shutdown breadcrumb on
# SIGTERM. STUB_NO_CLEAN_EXIT / STUB_NO_SINGLE break one promise each.
cat >"$LS/stub-app" <<'STUB'
#!/usr/bin/env bash
set -u
log() { printf '2026-01-01T00:00:00Z  INFO termihub_lib: %s\n' "$1" >>"$STUB_LOG"; }
log "termiHub starting version=\"$STUB_VERSION\" pid=$$ log_file=$STUB_LOG"
primary=true
if [ -z "${STUB_NO_SINGLE:-}" ] && ! mkdir "$STUB_LOCK" 2>/dev/null; then
  primary=false
fi
if [ "$primary" = true ]; then
  mkdir -p "$STUB_LOCK" && echo "$$" >"$STUB_LOCK/pid"
else
  printf '%s\n' "$@" >"$STUB_LOCK/req.$$.tmp"
  mv "$STUB_LOCK/req.$$.tmp" "$STUB_LOCK/req.$$"
  exit 0
fi
on_term() {
  log "Exit requested, shutting down"
  [ -n "${STUB_NO_CLEAN_EXIT:-}" ] || log "termiHub exited cleanly"
  rm -rf "$STUB_LOCK"
  exit 0
}
trap on_term TERM
log "Loading connections and folders"
while :; do
  for req in "$STUB_LOCK"/req.*; do
    case "$req" in *.tmp | *'*') continue ;; esac
    { read -r flag; read -r value; } <"$req"
    name="$value"
    if [ "$flag" = "--workspace-file" ]; then
      # The definition's own name is the first "name" key (tab groups follow).
      name="$(grep -o '"name":"[^"]*"' "$value" | head -n1 | cut -d'"' -f4)"
    fi
    rm -f "$req"
    log "single-instance: opening forwarded workspace workspace=$name"
  done
  sleep 0.2
done
STUB
chmod +x "$LS/stub-app"

# The macOS close path (#4076) needs osascript; this fake stands in for it. A
# click on the Quit menu item through System Events, and a Quit AppleEvent,
# each SIGTERM the stub (its breadcrumb then follows). FAKE_NO_MENU /
# FAKE_NO_APPLEEVENT make one refuse the way macOS does without the grant.
mkdir -p "$LS/fakebin"
cat >"$LS/fakebin/osascript" <<'FAKE'
#!/usr/bin/env bash
set -u
pid="$(cat "$STUB_LOCK/pid" 2>/dev/null || true)"
case "$*" in
  *'"System Events"'*)
    if [ -n "${FAKE_NO_MENU:-}" ]; then
      echo "execution error: osascript is not allowed assistive access. (-1719)" >&2
      exit 1
    fi
    if [ "${!#}" != "$pid" ]; then
      echo "menu click aimed at pid ${!#}, the app is pid $pid" >&2
      exit 1
    fi
    kill -TERM "$pid"
    echo "Quit termiHub"
    ;;
  *' to quit'*)
    if [ -n "${FAKE_NO_APPLEEVENT:-}" ]; then
      echo "execution error: Not authorized to send Apple events to termiHub. (-1743)" >&2
      exit 1
    fi
    kill -TERM "$pid"
    ;;
  *)
    echo "fake osascript: unexpected script: $*" >&2
    exit 1
    ;;
esac
FAKE
chmod +x "$LS/fakebin/osascript"

# The bash smoke and its PowerShell twin (the Windows release smoke), the latter
# only where pwsh is installed (GitHub's ubuntu runners have it). `applevent` is
# the bash smoke with the macOS close path, against the fake osascript.
lifecycle_cmd() { # <sh|applevent|ps1>: the smoke command line for the stub
  if [ "$1" = sh ]; then
    echo bash scripts/internal/release-smoke-app-lifecycle.sh --exe "$LS/stub-app" \
      --log "$LS/termihub.log" --version 9.8.7 --close sigterm --out "$LS/out"
  elif [ "$1" = applevent ]; then
    echo bash scripts/internal/release-smoke-app-lifecycle.sh --exe "$LS/stub-app" \
      --log "$LS/termihub.log" --version 9.8.7 --close applevent \
      --bundle-id com.termihub.app --out "$LS/out"
  else
    echo pwsh -NoProfile -File scripts/internal/release-smoke-app-lifecycle.ps1 -Exe "$LS/stub-app" \
      -Log "$LS/termihub.log" -Version 9.8.7 -Close signal -OutDir "$LS/out"
  fi
}
# lifecycle_run <kind> <label> <expect: pass|skip|fail> [VAR=value...]: run the
# smoke on the stub. `pass` is exit 0 with no skipped check, `skip` is exit 0
# with one reported as skipped, `fail` is exit 1.
lifecycle_run() {
  local kind="$1" label="$2" expect="$3" out rc=0
  local -a cmd
  shift 3
  read -r -a cmd <<<"$(lifecycle_cmd "$kind")"
  label="(${kind}) ${label}"
  rm -rf "$LS/lock" "$LS/termihub.log"
  out="$(env PATH="$LS/fakebin:$PATH" STUB_LOG="$LS/termihub.log" STUB_LOCK="$LS/lock" \
    STUB_VERSION=9.8.7 SMOKE_IPC_TIMEOUT=20 SMOKE_EXIT_TIMEOUT=5 SMOKE_LOG_TIMEOUT=5 \
    "$@" "${cmd[@]}" 2>&1)" || rc=$?
  local skipped=false
  if grep -qF 'skipped a check' <<<"$out"; then skipped=true; fi
  if { [ "$expect" = pass ] && [ "$rc" -eq 0 ] && [ "$skipped" = false ]; } ||
    { [ "$expect" = skip ] && [ "$rc" -eq 0 ] && [ "$skipped" = true ]; } ||
    { [ "$expect" = fail ] && [ "$rc" -eq 1 ]; }; then
    echo "ok    app lifecycle smoke: ${label} (exit ${rc})"
  else
    echo "::error file=scripts/internal/release-smoke-app-lifecycle.sh::app lifecycle smoke:" \
      "${label}: expected ${expect}, got exit ${rc}"
    printf '%s\n' "$out" | sed 's/^/    | /'
    failures=$((failures + 1))
  fi
}
lifecycle_kinds=(sh)
if command -v pwsh >/dev/null 2>&1; then
  lifecycle_kinds+=(ps1)
else
  echo "skip  app lifecycle smoke: PowerShell twin (pwsh not installed)"
fi
for kind in "${lifecycle_kinds[@]}"; do
  lifecycle_run "$kind" "passes on a faithful stub app" pass
  lifecycle_run "$kind" "fails when the clean-exit line is missing" fail STUB_NO_CLEAN_EXIT=1
  lifecycle_run "$kind" "fails when a second instance keeps running" fail STUB_NO_SINGLE=1
done
lifecycle_run applevent "macOS Quit through the app's menu item" pass
lifecycle_run applevent "falls back to a Quit AppleEvent when System Events refuses" pass \
  FAKE_NO_MENU=1
lifecycle_run applevent "reports the clean exit as skipped when no Quit is deliverable" skip \
  FAKE_NO_MENU=1 FAKE_NO_APPLEEVENT=1
lifecycle_run applevent "fails when a delivered Quit leaves no clean-exit line" fail \
  STUB_NO_CLEAN_EXIT=1
rm -rf "$LS/lock"
app_lifecycle_and_earlier_failures="$failures"

# --- Release test-bridge guard (#4122) ---
# assert-no-test-bridge.sh must pass a binary without the test-bridge build
# marker and fail (exit 1) on one that carries it, so the release gate is proven
# to bite before a release depends on it. The dummy binaries hold NUL bytes like
# a real one; the marker is read from its Rust definition, as the guard does.
GUARD="scripts/internal/assert-no-test-bridge.sh"
TB="$LC/test-bridge-guard"
mkdir -p "$TB"
tb_marker="$(sed -n 's/^pub const TEST_BRIDGE_BUILD_MARKER: &str = "\(.*\)";$/\1/p' \
  src-tauri/src/utils/test_bridge.rs)"
printf 'release\0binary\0' >"$TB/release-app"
printf 'test\0%s\0binary' "$tb_marker" >"$TB/test-bridge-app"
guard_run() { # <label> <expected exit> <binary...>
  local label="$1" want="$2" out rc=0
  shift 2
  out="$(bash "$GUARD" "$@" 2>&1)" || rc=$?
  if [ -n "$tb_marker" ] && [ "$rc" -eq "$want" ]; then
    echo "ok    test-bridge guard: ${label} (exit ${rc})"
  else
    echo "::error file=${GUARD}::test-bridge guard: ${label}: expected exit ${want}, got ${rc}"
    printf '%s\n' "$out" | sed 's/^/    | /'
    failures=$((failures + 1))
  fi
}
guard_run "passes a binary without the marker" 0 "$TB/release-app"
guard_run "fails a binary built with test-bridge" 1 "$TB/release-app" "$TB/test-bridge-app"
guard_run "refuses a missing binary" 2 "$TB/missing"

# --- Bundled plugin runner check (#4202) ---
# The stub runner answers like the real one: exit 64 (usage) to a wrong
# --protocol. The stub app embeds the runner's SHA-256 between NUL bytes, as
# core/build.rs embeds it into the real binary's read-only data.
PRB="scripts/internal/verify-plugin-runner-bundle.sh"
PR="$LC/plugin-runner-bundle"
mkdir -p "$PR/ok" "$PR/norun" "$PR/bare"
usage_src="$(sed -n 's/^ *pub const USAGE: i32 = \([0-9]*\);$/\1/p' plugin-runner/src/runner/mod.rs)"
printf "#!/bin/sh\n[ \"\$1 \$2\" = '--protocol 0' ] && exit %s\nexit 0\n" "$usage_src" \
  >"$PR/ok/termihub-plugin-runner"
printf '#!/bin/sh\nexit 0\n' >"$PR/norun/termihub-plugin-runner"
chmod +x "$PR/ok/termihub-plugin-runner" "$PR/norun/termihub-plugin-runner"
pr_digest() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -c1-64
}
printf 'app\0%s\0binary' "$(pr_digest "$PR/ok/termihub-plugin-runner")" >"$PR/ok/termihub"
printf 'app\0%s\0binary' "$(pr_digest "$PR/norun/termihub-plugin-runner")" >"$PR/norun/termihub"
printf 'app\0no digest\0binary' >"$PR/bare/termihub"
cp "$PR/ok/termihub-plugin-runner" "$PR/bare/"
prb_run() { # <label> <expected exit> <args...>
  local label="$1" want="$2" out rc=0
  shift 2
  out="$(bash "$PRB" "$@" 2>&1)" || rc=$?
  if [ "$usage_src" = 64 ] && [ "$rc" -eq "$want" ]; then
    echo "ok    plugin runner bundle check: ${label} (exit ${rc})"
  else
    echo "::error file=${PRB}::plugin runner bundle check: ${label}: expected exit ${want}," \
      "got ${rc} (runner usage code in source: '${usage_src}', script expects 64)"
    printf '%s\n' "$out" | sed 's/^/    | /'
    failures=$((failures + 1))
  fi
}
prb_run "passes a bundled runner the app embeds" 0 "$PR/ok/termihub"
prb_run "fails a runner that does not answer with its usage code" 1 "$PR/norun/termihub"
prb_run "--no-run skips the start check, not the digest" 0 --no-run "$PR/norun/termihub"
prb_run "fails a runner whose digest the app does not embed" 1 "$PR/bare/termihub"
prb_run "--runner checks a runner kept elsewhere" 0 --runner "$PR/ok/termihub-plugin-runner" \
  "$PR/ok/termihub"
prb_run "--runner still requires the app to embed its digest" 1 \
  --runner "$PR/norun/termihub-plugin-runner" --no-run "$PR/ok/termihub"
rm "$PR/bare/termihub-plugin-runner"
prb_run "fails a missing runner" 1 "$PR/bare/termihub"
prb_run "fails a missing app binary" 1 "$PR/missing/termihub"
prb_run "refuses no app binary" 2
test_bridge_and_earlier_failures="$failures"

# --- Bundled RDP helper check (#4222) ---
# The stub app embeds the helper's SHA-256 between NUL bytes, as core/build.rs
# embeds it into the real binary's read-only data. Appending a byte stands in
# for a signing step that rewrote the helper after staging.
RHB="scripts/internal/verify-rdp-helper-bundle.sh"
RH="$LC/rdp-helper-bundle"
mkdir -p "$RH/ok" "$RH/rewritten" "$RH/bare"
printf '#!/bin/sh\nexit 0\n' >"$RH/ok/termihub-rdp-helper"
chmod +x "$RH/ok/termihub-rdp-helper"
rh_digest() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -c1-64
}
printf 'app\0%s\0binary' "$(rh_digest "$RH/ok/termihub-rdp-helper")" >"$RH/ok/termihub"
cp "$RH/ok/termihub" "$RH/ok/termihub-rdp-helper" "$RH/rewritten/"
printf '\0' >>"$RH/rewritten/termihub-rdp-helper"
printf 'app\0no digest\0binary' >"$RH/bare/termihub"
rhb_run() { # <label> <expected exit> <args...>
  local label="$1" want="$2" out rc=0
  shift 2
  out="$(bash "$RHB" "$@" 2>&1)" || rc=$?
  if [ "$rc" -eq "$want" ]; then
    echo "ok    RDP helper bundle check: ${label} (exit ${rc})"
  else
    echo "::error file=${RHB}::RDP helper bundle check: ${label}: expected exit ${want}, got ${rc}"
    printf '%s\n' "$out" | sed 's/^/    | /'
    failures=$((failures + 1))
  fi
}
rhb_run "passes a bundled helper the app embeds" 0 "$RH/ok/termihub"
rhb_run "fails a helper rewritten after staging" 1 "$RH/rewritten/termihub"
rhb_run "--helper checks a helper kept elsewhere" 0 --helper "$RH/ok/termihub-rdp-helper" \
  "$RH/rewritten/termihub"
rhb_run "fails a missing helper" 1 "$RH/bare/termihub"
cp "$RH/ok/termihub-rdp-helper" "$RH/bare/"
rhb_run "fails a helper whose digest the app does not embed" 1 "$RH/bare/termihub"
rhb_run "fails a missing app binary" 1 "$RH/missing/termihub"
rhb_run "refuses no app binary" 2

# --- Windows bundle check exit codes (#4207) ---
# A .ps1 that falls off its end leaves the caller's $LASTEXITCODE untouched
# ($null in a fresh pwsh step), so the workflow guard failed a passing check.
# The PowerShell test runs both bundle checks on dummy binaries and asserts
# their exit codes; it needs pwsh (GitHub's ubuntu runners have it).
if command -v pwsh >/dev/null 2>&1; then
  vb_rc=0
  vb_out="$(pwsh -NoProfile -NonInteractive -File scripts/internal/test-verify-bundle-scripts.ps1 2>&1)" ||
    vb_rc=$?
  printf '%s\n' "$vb_out"
  if [ "$vb_rc" -ne 0 ]; then
    failures=$((failures + 1))
  fi
else
  echo "skip  Windows bundle check exit codes (pwsh not installed)"
fi

echo ""
if [ "$failures" -gt 0 ]; then
  echo "Headless script smoke FAILED: ${help_failures} --help path(s) errored," \
    "${lifecycle_failures} signing-lifecycle check(s) failed," \
    "$((sidecar_and_earlier_failures - help_failures - lifecycle_failures)) checksum-sidecar" \
    "check(s) failed," \
    "$((app_lifecycle_and_earlier_failures - sidecar_and_earlier_failures)) app-lifecycle-smoke" \
    "check(s) failed," \
    "$((test_bridge_and_earlier_failures - app_lifecycle_and_earlier_failures)) test-bridge-guard" \
    "or plugin-runner-bundle check(s) failed, $((failures - test_bridge_and_earlier_failures)) RDP-helper-bundle" \
    "or bundle-check exit-code test(s) failed."
  exit 1
fi
echo "Headless script smoke OK: ${#SCRIPTS[@]} script(s) executed their --help path cleanly;" \
  "the signing-key dry-run lifecycle, the checksum sidecar writer, the app lifecycle" \
  "smoke (on a stub app), the release test-bridge guard, the plugin runner and RDP helper" \
  "bundle checks and the Windows bundle check exit codes passed."
