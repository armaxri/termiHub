---
id: WA-CI-030
title: release-check.sh TODO/FIXME/HACK scan is warn-only, not a hard gate
angle: workaround-ci-scripts
severity: low
category: workaround
is_workaround: true
subsystem: scripts
evidence:
  - scripts/release-check.sh:148
  - scripts/release-check.sh:155
status: open
---

## What
`release-check.sh` scans `src/ src-tauri/src/ core/src/ agent/src/` for `TODO/FIXME/HACK`
markers (line 148-161) but only `warn`s when it finds them (`warn "Found $MARKER_COUNT
TODO/FIXME/HACK markers in source code"`, line 155) — it does not fail the release check. The
grep is also `|| true`-guarded so a zero-match exit never errors.

## Why it matters
For a ventilator-grade, no-workarounds-at-release goal, a warn-only marker scan means a release
can be cut with unresolved TODO/FIXME/HACK markers in shipping code — precisely the workarounds
this whole audit exists to eliminate. The tooling to catch them exists but doesn't bite.

## Why it may be intentional
Markers in comments/tests are common and a hard fail would be noisy — hence warn. But it means
the marker count is advisory.

## Evidence
`warn "Found $MARKER_COUNT TODO/FIXME/HACK markers…"` (line 155) vs. `pass` (line 161); the whole
block is non-fatal.

## Recommendation
For the release cut specifically, make the marker scan a hard gate (or gate on a curated subset:
`HACK`/`FIXME`/`XXX` fail, `TODO` warns). Pair with the audit's workaround inventory so the
release-check reflects the actual "no workarounds" bar. Low, but directly aligned with the
release goal.
