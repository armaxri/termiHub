---
id: PKG-005
title: macOS re-sign step swallows codesign failures on inner binaries, can ship an inconsistently-signed bundle
angle: packaging-release
severity: medium
category: workaround
is_workaround: true
subsystem: .github/workflows/release.yml
evidence:
  - .github/workflows/release.yml:234
  - .github/workflows/release.yml:241
status: open
---

## What
The macOS "Re-sign DMG with consistent ad-hoc signature" step signs inner Mach-O files
and nested bundles with `codesign -s - --force "$f" 2>/dev/null || true` — stderr is
discarded and a non-zero exit is ignored. Only the final top-level
`codesign -s - --force "$APP"` can fail the job. The subsequent `spctl --assess` and
`codesign -dv` are diagnostics that also end in `|| true`.

## Why it matters
The entire reason this step exists is that Tauri's own ad-hoc signing can leave the
bundle in an inconsistent state that Gatekeeper classifies as "damaged" — an
unbypassable error. If one of the inner `codesign` invocations fails (e.g. a helper
the loop did not anticipate, a permissions issue, an unexpected Mach-O layout), the
failure is silently swallowed, the DMG is repackaged anyway, and a subtly
inconsistent — potentially "damaged" — bundle is uploaded and published. The release
pipeline would report success. Because there is no macOS install-smoke test
(PKG-006), nothing downstream would catch it before users do.

## Evidence
- `release.yml:234-238` — inner Mach-O signing loop: `... 2>/dev/null || true`.
- `release.yml:241-245` — nested-bundle signing loop: `... 2>/dev/null || true`.
- `release.yml:248` — only the top-level sign is allowed to fail.
- The final `spctl --assess` (line 252) is printed but not asserted (`|| true`), so a
  "rejected" assessment does not fail the build.

## Recommendation
Make signing failures fatal: drop the `|| true` on the per-file/per-bundle loops (or
collect failures and exit non-zero), and turn the `spctl --assess --type exec` result
into a hard gate — fail the job unless the assessment is "accepted"/"ad-hoc". This
converts a silent-ship into a caught-in-CI failure. Pair with PKG-006 (a macOS
launch-smoke on the produced DMG) so a "damaged" bundle can never reach the release
page.
