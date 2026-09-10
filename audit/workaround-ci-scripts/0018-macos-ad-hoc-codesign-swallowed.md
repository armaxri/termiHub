---
id: WA-CI-018
title: macOS release DMG is ad-hoc signed (codesign -s -) with errors swallowed by || true
angle: workaround-ci-scripts
severity: high
category: packaging
is_workaround: true
subsystem: .github/workflows
evidence:
  - .github/workflows/release.yml:236
  - .github/workflows/release.yml:242
  - .github/workflows/release.yml:252
  - .github/workflows/dev-build.yml:191
status: open
---

## What
The Release (and dev-build) workflows re-sign the macOS `.app` with **ad-hoc** signing
(`codesign -s -`, i.e. no Developer ID identity) inside-out, and the per-file / per-bundle
signing steps swallow failures with `2>/dev/null || true` (release.yml lines 236, 242;
dev-build.yml 191, 197). The Gatekeeper assessment and signature dump are also `|| true`
(lines 252, 254), so a failed/unaccepted signature is only diagnostic, never fatal.

## Why it matters
Ad-hoc signing means the shipped macOS build is **unsigned/un-notarized**: Gatekeeper will warn
or block on end-user machines, and there is no code-identity guarantee on a safety-critical app.
The `|| true` on the individual Mach-O/bundle signing means a binary that *fails* to sign is
silently shipped inside a bundle that only the top-level `codesign` (no `|| true`) must pass —
so a partially-signed app can be released. This is a real release-quality stopgap.

## Why it is (currently) accepted
Per the release-strategy memory, the maintainer chose an **unsigned beta** for v0.1.0, deferring
Developer ID signing + notarization to pre-v1.0. So this is a *tracked, decided* stopgap — but
it is exactly the kind that must be removed before a broad release.

## Evidence
`codesign -s - --force "$f" 2>/dev/null || true` (release.yml:236, 242; dev-build.yml:191, 197);
`spctl --assess … || true` (line 252); top-level `codesign -s - --force "$APP"` with no
fallback (line 250).

## Recommendation
Retire before general availability: replace ad-hoc signing with real Developer ID signing +
notarization (`xcrun notarytool`) driven by secrets, and drop the `|| true` on the signing
steps so a signing failure hard-fails the release. Until then, the unsigned status must be
called out in release notes. Tracked under the release-strategy signing deferral (#480 folded
into #2650). High for a public release.
