---
id: PKG-006
title: No macOS or Windows install/launch smoke test in the release pipeline; Intel macOS DMG is cross-built and entirely unverified
angle: packaging-release
severity: high
category: test-gap
is_workaround: false
subsystem: .github/workflows
evidence:
  - .github/workflows/release-linux-smoke.yml:48
  - .github/workflows/release-linux-arm64-smoke.yml:1
  - .github/workflows/release.yml:103
status: open
---

## What
Post-build install-and-launch smoke coverage exists only for Linux:
`release-linux-smoke.yml` (x64 AppImage + .deb) and `release-linux-arm64-smoke.yml`
(arm64 .deb/.rpm). There is **no equivalent for the macOS DMGs or the Windows MSI** —
those artifacts are built, ad-hoc-signed/packaged, uploaded, and published without any
automated "does it install and launch" check.

The gap is worst for **macOS Intel**: the `macos-x64` artifact is cross-compiled for
`x86_64-apple-darwin` on an Apple-Silicon `macos-latest` runner, so the produced Intel
binary is never even executed on CI, let alone smoke-tested. The Windows MSI is
likewise never installed/launched in the release flow.

## Why it matters
`verify-release` (release.yml) only checks that asset *names* are present and notes are
non-empty — it does not run anything. Combined with the error-swallowing macOS re-sign
(PKG-005), a broken/"damaged" macOS bundle or a non-launching Windows MSI can be
published with a green pipeline and discovered only by users. For a turnkey
"push-one-tag" release this is the highest-value missing gate on the two platforms that
already greet users with security warnings.

## Evidence
- `release-linux-smoke.yml:48` — Linux x64 install+smoke job (the only desktop smoke in
  the release path); ARM64 equivalent in `release-linux-arm64-smoke.yml`.
- No `*-smoke` workflow or in-release launch step for macOS or Windows.
- `release.yml:103-114` — both macOS targets run on `macos-latest` (arm64); the Intel
  build is cross-compiled and never executed.
- `release.yml:463-547` — `verify-release` validates asset presence only, no launch.

## Recommendation
Add macOS and Windows post-release install-smoke jobs mirroring the Linux ones:
- **macOS:** on both an arm64 and (ideally) an Intel runner, mount the published DMG,
  copy out the `.app`, strip quarantine, launch headlessly, and assert it stays alive
  and exits cleanly (`scripts/smoke-test.sh` process-fallback works cross-platform).
  Assert `spctl`/`codesign -v` passes.
- **Windows:** install the MSI silently (`msiexec /i /qn`), launch the app, confirm it
  stays up, then uninstall. `scripts/smoke-test.cmd` already exists.
Gate the release on these, so the unverified Intel DMG and the Windows MSI are proven
to launch before publication.
