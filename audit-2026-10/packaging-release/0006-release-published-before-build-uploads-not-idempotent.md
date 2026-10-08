---
id: PKG2-006
title: "Release is published (non-draft) before anything is built, and uploads lack --clobber: a failed leg leaves a public partial release that 're-run failed jobs' cannot finish"
angle: packaging-release
severity: low
category: reliability
is_workaround: false
subsystem: ".github/workflows/release.yml"
evidence:
  - .github/workflows/release.yml:263-267
  - .github/workflows/release.yml:649-652
  - .github/workflows/release.yml:663
  - .github/workflows/release.yml:678
  - .github/workflows/release.yml:762-763
  - .github/workflows/release.yml:818-819
  - .github/workflows/release.yml:899-900
  - .github/workflows/release.yml:980
  - .github/workflows/release.yml:1075
  - .github/workflows/release.yml:1146
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: new
---

## What

create-release publishes a non-draft (pre)release, and only afterwards do the build matrix, agent, notices and SBOM jobs upload assets. Every upload except the signing job's uses `gh release upload` without `--clobber`, and GitHub rejects an asset name that already exists. A leg that uploads and then fails later can therefore not be completed by re-running failed jobs: its upload step now fails on 'already exists'. Examples: linux-x64 uploads the AppImage and then the .deb upload fails; any leg whose 'Attest build provenance' step hits a transient Sigstore error after upload. The release-integration-gate failure message itself recommends re-running failed jobs. Meanwhile the incomplete release is publicly visible under the tag.

## Why it matters

For the first public release, one transient failure on a slow runner (macOS or Windows) forces the maintainer to delete assets or the release by hand, or to burn a new tag, contrary to the 'push one tag → turnkey beta' goal. Users can also find and download a half-populated release in the meantime.

## Evidence

- `.github/workflows/release.yml:263-267`
- `.github/workflows/release.yml:649-652`
- `.github/workflows/release.yml:663`
- `.github/workflows/release.yml:678`
- `.github/workflows/release.yml:762-763`
- `.github/workflows/release.yml:818-819`
- `.github/workflows/release.yml:899-900`
- `.github/workflows/release.yml:980`
- `.github/workflows/release.yml:1075`
- `.github/workflows/release.yml:1146`

## Recommendation

Create the release with `--draft` and publish it (`gh release edit --draft=false`) in a final job after verify-release, before or together with mark-latest. Make every upload idempotent with `--clobber`. Re-running then also re-attests, and verify-release already re-verifies attestations against the final assets.

## Verification

Partly a documented decision. audit/FINAL-SUMMARY.md CI-007 records 'publish-as-prerelease then verify-assets' as the chosen release model (#2650), so publishing before the builds is deliberate and the default is a prerelease that is never marked latest. The idempotency defect is still real and not covered by that decision: every gh release upload except the signatures upload at line 1146 lacks --clobber (lines 650, 663, 678, 762, 818, 899, 980, 1075). A leg that has already uploaded cannot finish on a re-run of failed jobs. I lowered it to low because the visible-partial-release half is an accepted decision.
