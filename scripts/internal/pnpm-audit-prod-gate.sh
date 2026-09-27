#!/usr/bin/env bash
#
# Blocking production-dependency security gate for CI (issue #2589).
#
# `pnpm audit --prod --audit-level=high` exits non-zero for TWO unrelated
# reasons: (a) a real high/critical advisory in the runtime tree, and (b) a
# transient registry/network error (e.g. ERR_SOCKET_TIMEOUT reaching
# registry.npmjs.org's audit endpoint). Gating CI on that raw exit code reds
# every PR whenever the registry blips, even on a clean dependency tree
# (observed 2026-09-04: develop's push-run and PR #2586 both failed in the same
# window with no dep change).
#
# This script separates the two cases by parsing the `--json` payload instead of
# trusting the exit code:
#   - A parseable payload with metadata.vulnerabilities -> gate on it: fail only
#     when high + critical > 0 (the real advisory case).
#   - An empty / non-JSON payload (registry unreachable) -> retry with backoff,
#     then SOFT-PASS with a warning, mirroring the sibling advisory-only step's
#     `continue-on-error` posture. A network blip must not red the lane.
#
# The gate therefore stays genuinely blocking for real high/critical production
# advisories while tolerating transient registry outages.
#
# Strict mode (WA-CI-008): a soft-pass means the tree was NOT audited. That is an
# acceptable trade on develop and PRs, but not for what ships. On `main`,
# `release/*` branches and tags, strict mode turns "registry unreachable" into a
# hard failure. Whenever the gate soft-passes it also writes an
# "AUDIT SKIPPED — registry unreachable" marker to $GITHUB_STEP_SUMMARY, so a
# skipped audit is visible on the run page instead of hiding in a green check.
#
# Env knobs (defaults suit CI):
#   AUDIT_STRICT           1/true forces strict mode, 0/false forces lenient
#                          mode; unset/empty -> strict when GITHUB_REF is
#                          refs/heads/main, refs/heads/release/* or refs/tags/*
#                          (the Release workflow sets AUDIT_STRICT=1 explicitly)
#   AUDIT_MAX_ATTEMPTS     registry attempts before giving up             (default 3)
#   AUDIT_BACKOFF_SECONDS  base backoff, multiplied by attempt number    (default 5)
#   AUDIT_JSON_FILE        read canned JSON from this file instead of
#                          invoking pnpm (test injection only)

set -euo pipefail

MAX_ATTEMPTS="${AUDIT_MAX_ATTEMPTS:-3}"
BACKOFF_SECONDS="${AUDIT_BACKOFF_SECONDS:-5}"

# Emit a GitHub Actions annotation when running in CI, otherwise a plain line.
warn() { echo "::warning::$*"; }
fail() { echo "::error::$*"; }

# Resolve strict mode: an explicit AUDIT_STRICT wins, otherwise infer it from the
# ref being built. Prints "1" (strict) or "0" (lenient).
resolve_strict() {
  case "${AUDIT_STRICT:-}" in
  1 | true | TRUE | yes) echo 1 ;;
  0 | false | FALSE | no) echo 0 ;;
  "")
    case "${GITHUB_REF:-}" in
    refs/heads/main | refs/heads/release/* | refs/tags/*) echo 1 ;;
    *) echo 0 ;;
    esac
    ;;
  *)
    # stderr: stdout is captured into STRICT below.
    fail "AUDIT_STRICT must be 1/true/yes or 0/false/no, got '${AUDIT_STRICT}'." >&2
    exit 2
    ;;
  esac
}

STRICT="$(resolve_strict)"
if [ "$STRICT" = "1" ]; then
  echo "Production audit gate: strict mode (AUDIT_STRICT=${AUDIT_STRICT:-auto}, GITHUB_REF=${GITHUB_REF:-unset}); an unreachable registry fails."
else
  echo "Production audit gate: lenient mode; an unreachable registry soft-passes with a marker."
fi

# Append a line to the GitHub job summary when running in Actions.
summary() {
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    printf '%s\n' "$*" >>"$GITHUB_STEP_SUMMARY"
  fi
}

# Produce the audit JSON. In tests, AUDIT_JSON_FILE short-circuits the network
# call so the three code paths can be exercised deterministically with canned
# payloads (the real registry is slow/flaky to hit from CI or a dev box).
run_audit() {
  if [ -n "${AUDIT_JSON_FILE:-}" ]; then
    cat "$AUDIT_JSON_FILE"
    return 0
  fi
  # pnpm exits non-zero on a real advisory AND on a network error; we inspect the
  # payload rather than $?, so swallow the status here and classify below.
  pnpm audit --prod --audit-level=high --json
}

# Classify a payload with Node (already a hard project dependency; jq is often
# absent — see scripts/internal/autoformat.sh / #1084). Prints:
#   "OK <high> <critical>"  when metadata.vulnerabilities parsed cleanly
#   "ERR"                   when the payload is missing / not valid audit JSON
classify() {
  node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      try {
        const j = JSON.parse(s);
        const v = j && j.metadata && j.metadata.vulnerabilities;
        if (!v || typeof v.high !== "number" || typeof v.critical !== "number") {
          process.stdout.write("ERR");
          return;
        }
        process.stdout.write("OK " + v.high + " " + v.critical);
      } catch {
        process.stdout.write("ERR");
      }
    });
  '
}

attempt=1
while :; do
  output="$(run_audit || true)"
  verdict="$(printf '%s' "$output" | classify 2>/dev/null || echo ERR)"

  case "$verdict" in
  "OK "*)
    # shellcheck disable=SC2034  # `_` intentionally discards the "OK" token.
    read -r _ high critical <<<"$verdict"
    total=$((high + critical))
    if [ "$total" -gt 0 ]; then
      fail "Production dependency audit found ${high} high and ${critical} critical advisory(ies)."
      echo "Run 'pnpm audit --prod --audit-level=high' locally to see the details."
      exit 1
    fi
    echo "Production dependency audit clean (0 high, 0 critical)."
    exit 0
    ;;
  *)
    # Registry/network error: the payload was empty or not audit JSON.
    if [ "$attempt" -lt "$MAX_ATTEMPTS" ]; then
      delay=$((BACKOFF_SECONDS * attempt))
      warn "pnpm audit could not reach the registry (attempt ${attempt}/${MAX_ATTEMPTS}); retrying in ${delay}s."
      sleep "$delay"
      attempt=$((attempt + 1))
      continue
    fi
    ref="${GITHUB_REF:-local}"
    if [ "$STRICT" = "1" ]; then
      summary "### :x: AUDIT SKIPPED — registry unreachable (strict mode: FAILED)"
      summary ""
      summary "\`pnpm audit --prod\` could not reach the npm registry after ${MAX_ATTEMPTS} attempts" \
        "on \`${ref}\`. Strict mode (main, release branches, tags) does not ship an" \
        "unaudited tree: re-run the job once the registry is reachable."
      fail "pnpm audit could not reach the npm registry after ${MAX_ATTEMPTS} attempts; \
strict mode (${ref}) refuses to pass an unaudited production tree. Re-run once the registry \
is reachable. See WA-CI-008."
      exit 1
    fi
    summary "### :warning: AUDIT SKIPPED — registry unreachable"
    summary ""
    summary "\`pnpm audit --prod\` could not reach the npm registry after ${MAX_ATTEMPTS} attempts" \
      "on \`${ref}\`; the production audit gate soft-passed WITHOUT auditing the tree" \
      "(transient network error, not an advisory). See #2589."
    warn "AUDIT SKIPPED — pnpm audit could not reach the npm registry after ${MAX_ATTEMPTS} attempts; \
soft-passing the production audit gate (transient network error, not an advisory). See #2589."
    exit 0
    ;;
  esac
done
