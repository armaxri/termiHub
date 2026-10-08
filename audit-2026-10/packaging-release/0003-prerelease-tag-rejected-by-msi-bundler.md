---
id: PKG2-003
title: "The documented semver-prerelease tag path (vX.Y.Z-beta.1 / -rc.1) cannot build: the Windows MSI bundler rejects a non-numeric prerelease that the version gate requires"
angle: packaging-release
severity: medium
category: packaging
is_workaround: false
subsystem: ".github/workflows/release.yml + src-tauri/tauri.conf.json"
evidence:
  - .github/workflows/release.yml:244-245
  - .github/workflows/release.yml:257
  - .github/workflows/release.yml:302-308
  - docs/contributing.md:1443-1444
  - scripts/release-check.sh:274-276
  - src-tauri/tauri.conf.json:4
  - src-tauri/tauri.conf.json:66
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: new
---

## What

release.yml and docs/contributing.md advertise prerelease tags such as `vX.Y.Z-beta.1` and `vX.Y.Z-rc.1`. verify-version runs `release-check.sh --expect-version "${TAG#v}"`, which requires package.json, tauri.conf.json and the Cargo manifests to say exactly `X.Y.Z-beta.1`. The Windows leg builds an MSI (`targets: all`, file_ext .msi), and Tauri's WiX bundler refuses an app version whose prerelease identifier is not numeric-only and ≤ 65535 ('optional pre-release identifier in app version must be numeric-only … for msi target'). No `bundle.windows.wix.version` override is set. Such a tag therefore passes the version gate and creates the GitHub release, then the windows-x64 leg fails, verify-release fails, and a partial prerelease is left published.

## Why it matters

The only documented way to cut an explicit beta or RC tag is broken on one of the three platforms, and the failure happens after the release has been created publicly (see the non-idempotent publish finding).

## Evidence

- `.github/workflows/release.yml:244-245`
- `.github/workflows/release.yml:257`
- `.github/workflows/release.yml:302-308`
- `docs/contributing.md:1443-1444`
- `scripts/release-check.sh:274-276`
- `src-tauri/tauri.conf.json:4`
- `src-tauri/tauri.conf.json:66`

## Recommendation

Choose one: (a) allow only numeric prereleases (`vX.Y.Z-1`) and enforce that in verify-version with a regex, updating the comment and contributing.md; or (b) when the tag has a prerelease, set `bundle.windows.wix.version` to a numeric mapping (e.g. X.Y.Z.<n>) through a generated `--config` fragment on the Windows leg. Either way, add a verify-version check so a tag the MSI bundler will reject fails before create-release.

## Verification

Confirmed. verify-version runs release-check.sh --expect-version "${TAG#v}", an exact string match with no prerelease-format check. tauri.conf.json has targets "all" and no bundle.windows.wix.version, and the conpty config fragment only adds resources. The windows-x64 leg builds an MSI, and Tauri's WiX bundler rejects a non-numeric prerelease such as -beta.1. contributing.md:1443 and the release.yml comment both advertise -beta.1/-rc.1 tags. Nothing in the repo refutes this.
