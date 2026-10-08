---
id: PKG2-005
title: "The macOS first-launch bypass shipped in every release body and the README (right-click → Open) no longer works on macOS 15+"
angle: packaging-release
severity: medium
category: docs
is_workaround: false
subsystem: ".github/workflows/release.yml + README.md"
evidence:
  - .github/workflows/release.yml:226-234
  - README.md:31
  - README.md:84
  - .github/workflows/dev-build.yml:309
  - .github/workflows/dev-build.yml:727
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: new
---

## What

The release body appended by create-release, and the README install steps, tell macOS users to 'Right-click termiHub.app → Open → Open'. Since macOS Sequoia (15), Apple removed the Control-click/right-click Open override for unnotarized apps: the user has to try to open the app, then approve it in System Settings → Privacy & Security → Open Anyway. dev-build.yml already documents that correct flow (lines 309 and 727), so the two release surfaces disagree. The `xattr -dr com.apple.quarantine` alternative in the release body still works, but the README offers only the right-click route.

## Why it matters

Under the unsigned-beta decision, these instructions are the whole install UX on macOS. On current macOS (15/26), the primary route sends users into a dialog that offers no Open button, so the beta is not turnkey for most Mac users.

## Evidence

- `.github/workflows/release.yml:226-234`
- `README.md:31`
- `README.md:84`
- `.github/workflows/dev-build.yml:309`
- `.github/workflows/dev-build.yml:727`

## Recommendation

Change the release body text (release.yml:226-234) and README.md:31/84 to the System Settings → Privacy & Security → 'Open Anyway' flow, as dev-build.yml does. Keep the xattr one-liner, and mention right-click → Open only for macOS 14 and earlier.

## Verification

Confirmed. release.yml:232 and README.md:31/84 give right-click → Open as the bypass, while dev-build.yml:309 documents System Settings → Privacy & Security → Open Anyway. macOS 15 Sequoia removed the Control-click Open override for unnotarized apps. The xattr alternative is in the release body only, not in the README.
