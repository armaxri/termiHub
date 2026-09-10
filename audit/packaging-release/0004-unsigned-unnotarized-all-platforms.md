---
id: PKG-004
title: All three platforms ship unsigned/un-notarized (macOS ad-hoc only, Windows no Authenticode, Linux unsigned)
angle: packaging-release
severity: medium
category: workaround
is_workaround: true
subsystem: .github/workflows/release.yml
evidence:
  - .github/workflows/release.yml:60
  - .github/workflows/release.yml:213
  - docs/release-plan-0.1.0.md:516
status: open
---

## What
No real code-signing exists on any platform for v0.1.0 (a deliberate maintainer
decision — "unsigned public beta", 2026-09-06):

- **macOS:** the DMG is only **ad-hoc re-signed** (`codesign -s -`) after tauri-action
  builds it. This satisfies the Apple-Silicon kernel's "must be signed to exec" rule
  and avoids the "damaged" Gatekeeper state, but there is **no Developer-ID signature
  and no notarization** — first launch shows the "unverified developer" prompt and
  requires a right-click → Open (or `xattr -dr com.apple.quarantine`).
- **Windows:** the MSI is **not Authenticode-signed** — SmartScreen shows a
  "Windows protected your PC" warning; users must click More info → Run anyway. There
  is no Windows signing step in release.yml at all.
- **Linux:** `.deb`/`.rpm`/`.AppImage` are unsigned (no GPG repo signing), as is
  normal for direct-download Linux artifacts.

## Why it matters
Every platform greets first-run users with a security warning, which for a
security-sensitive terminal/SSH tool undercuts trust and hurts install conversion.
This is an accepted, tracked beta stopgap — not a defect to fix before v0.1.0 — but it
**must** be removed before v1.0 and the deferral must stay explicitly tracked. It is
recorded here so the release scorecard reflects the real posture.

## Evidence
- `release.yml:60-82` — appends the macOS "unsigned public beta (one-step bypass)"
  note to every release body.
- `release.yml:213-259` — the ad-hoc re-sign step; comments state there is no
  Developer-ID/notarization.
- No Windows signing step anywhere in release.yml; no `certificateThumbprint` /
  `signCommand` in tauri.conf.json.
- `docs/release-plan-0.1.0.md:516-517` documents the macOS/Windows warnings as known
  limitations.

## Recommendation
Ship the beta unsigned as decided, but keep the deferral tracked as a single explicit
pre-v1.0 blocker covering all three platforms: Apple Developer-ID cert + notarization
(`notarytool`) for macOS; an Authenticode cert (OV/EV or Azure Trusted Signing) for
Windows; optionally GPG-signed apt/rpm repos or at least detached signatures for
Linux. Wire the signing secrets into release.yml behind the existing matrix so the
switch to signed is a config change, not a pipeline rewrite. Ensure the release notes
stop claiming "unsigned" once signing lands.
