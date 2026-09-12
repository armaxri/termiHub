---
id: WA-CI-032
title: shellcheck disables on scripts CI never runs (SC2086 in build-agents, SC2034 in audit gate)
angle: workaround-ci-scripts
severity: low
category: workaround
is_workaround: true
subsystem: scripts
evidence:
  - scripts/build-agents.sh:300
  - scripts/internal/pnpm-audit-prod-gate.sh:82
status: open
---

## What
Two scripts carry `# shellcheck disable=` suppressions:
- `build-agents.sh` disables SC2086 (word-splitting) four times (lines 300, 306, 366, 370),
  around intentional `$DOCKER_ARGS`-style expansions.
- `pnpm-audit-prod-gate.sh:82` disables SC2034 with a justification (`_` intentionally discards
  the "OK" token).

`build-agents.sh` is **not run by any CI lane** (see WA-CI-029); `pnpm-audit-prod-gate.sh` IS
run in CI and has an accompanying `.test.mjs`.

## Why it matters
Per the coordinator's own SC2257 lesson, a `# shellcheck disable=` on a script CI never executes
is a red flag: shellcheck is static (won't catch a `set -u`/runtime failure the suppression
hides), and nothing else runs the script to catch it. The `build-agents.sh` SC2086 disables are
the higher-risk ones because that script is un-exercised in CI. The pnpm-audit SC2034 is
low-risk (CI-run + unit-tested + justified).

## Evidence
`# shellcheck disable=SC2086` (build-agents.sh:300, 306, 366, 370);
`# shellcheck disable=SC2034  # _ intentionally discards the "OK" token.` (pnpm-audit-prod-gate.sh:82).

## Recommendation
Verify each `build-agents.sh` SC2086 suppression by actually running the script (it builds the
release agent binaries — worth a scheduled/manual CI exercise anyway, WA-CI-029). Prefer arrays
over unquoted `$VAR` expansion to remove the suppression rather than disable the lint. The
pnpm-audit SC2034 is fine as-is. Low.
