---
id: CI-008
title: Desktop bundles ship with no checksums and no real signatures
angle: ci-cd
severity: high
category: supply-chain
is_workaround: true
subsystem: .github/workflows/release.yml
evidence:
  - .github/workflows/release.yml:280
  - .github/workflows/release.yml:213
  - .github/workflows/release.yml:367
status: open
---

## What
The release uploads the desktop installers (DMG ×2, MSI, AppImage, deb ×2, rpm) with **no checksum
sidecar and no code signature**:

- macOS DMGs are only **ad-hoc** re-signed (`codesign -s -`, `:213-259`) — a self-signature with no
  identity; Gatekeeper still shows "unverified developer" and the release notes ship a
  `xattr -dr com.apple.quarantine` bypass (`:60-82`).
- Windows MSI is **unsigned** (no Authenticode step anywhere in the matrix).
- Linux AppImage/deb/rpm get **no `.sha256`** at all.

Only the **agent** binaries publish a `sha256` sidecar the desktop verifies before install
(`:367`, `:410`, `:453`, `#1350`). The desktop installers a human downloads get nothing.

## Why it matters
Users install a safety-critical app from GitHub Releases with no way to verify the download's
integrity or origin: no checksum to compare, no signature to validate, and a documented instruction
to strip macOS quarantine. A tampered release asset (or a MITM'd download) is undetectable. This is
partly a deliberate "unsigned public beta" decision (maintainer, 2026-09-06) — hence `is_workaround`
— but the *checksum* gap is not covered by that decision and is cheap to close now; the *signing*
gap is the release blocker to schedule before v1.0.

## Evidence
No `sha256sum`/`shasum` step for the desktop `build-and-upload` matrix (contrast the agent jobs). No
`signtool`/Authenticode. macOS is ad-hoc only (`:213`, mirrored in `dev-build.yml:168`).

## Recommendation
Immediately: emit and upload a `.sha256` (and ideally a signed `SHA256SUMS`) for every desktop
bundle, and consider Sigstore/cosign keyless signing + GitHub build provenance attestation (see
CI-022) — all achievable without a paid cert. Before v1.0: real Apple Developer-ID notarization and
Windows Authenticode, per the release-strategy memo. Track the ad-hoc/unsigned state as an explicit
release-blocking checklist item, not a permanent state.
