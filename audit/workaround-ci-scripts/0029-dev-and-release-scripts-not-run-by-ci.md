---
id: WA-CI-029
title: Release-check and dev helper scripts are not exercised by any CI lane (drift/unverified)
angle: workaround-ci-scripts
severity: medium
category: reliability
is_workaround: true
subsystem: scripts
evidence:
  - scripts/release-check.sh:148
  - scripts/check.sh
  - scripts/build.sh
  - scripts/test-system-linux.sh
status: open
---

## What
CI runs the underlying tools directly (`cargo test`, `pnpm run lint`, `pytest.sh`, etc.), not
the developer-facing wrapper scripts. A cross-reference of `scripts/*.sh` against `.github/`
shows the following are referenced by **zero** workflows: `release-check.sh`, `check.sh`,
`build.sh`, `format.sh`, `clean.sh`, `setup.sh`, `dev.sh`, `test-system-{linux,mac,windows}.sh`,
`test-system-py.sh`, `build-agents.sh`, `setup-agent-cross.sh`, `run-guided-manual.sh`,
`autoformat.sh`, and most `scripts/internal/*.mjs`. Only `test.sh`, `smoke-test.sh`,
`package-plugin.sh`, `pnpm-audit-prod-gate.sh`, `emit-release-notes.mjs`, `parse-issue-refs.mjs`,
and `build-rdp-sidecar.sh` are invoked by a workflow.

## Why it matters
This is the SC2257 lesson generalized: a script that CI never runs is only ever validated by
someone running it locally, so it silently rots. `release-check.sh` is the **release gate** and
is not run by CI at all — if it breaks (a `set -u` failure, a renamed path, a bad grep), the
break is discovered at release time, exactly when it hurts most. The `.sh`/`.cmd` parity risk
compounds this: two implementations, neither CI-verified, can diverge.

## Evidence
`grep -rl <script> .github/` returns 0 for release-check.sh, check.sh, build.sh, the
test-system-* orchestrators, etc. `release-check.sh:148` (the TODO/FIXME scan) and its whole
release-gate logic run only on demand.

## Recommendation
Add a lightweight CI job that at least *executes* the release-relevant scripts to their
furthest safe point (a dry-run / no-op invocation catches `set -u`, path, and quoting breaks in
one second — the display-gated ones still run their pre-launch setup). Prioritize
`release-check.sh` (it is the gate) and `check.sh`/`format.sh` (they claim to mirror CI but are
never verified to). Consider a `.sh`/`.cmd` parity check for the pairs. Medium.
