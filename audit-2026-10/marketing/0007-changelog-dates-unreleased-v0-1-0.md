---
id: MKT2-007
title: "CHANGELOG dates a v0.1.0 release (2026-07-20) that has not happened, and its summary drops the experimental label"
angle: marketing / product positioning
severity: low
category: trust
is_workaround: false
subsystem: "CHANGELOG.md"
evidence:
  - "CHANGELOG.md:17"
  - "CHANGELOG.md:19"
  - "README.md:104"
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: new
---

## What

CHANGELOG.md:17 has the header `## [0.1.0] - 2026-07-20`. No v0.1.0 tag or release exists: the Releases page has only the 'Dev Build — not for production use' pre-releases and the dev-\*-latest tags. The intro line (CHANGELOG.md:19) lists 'remote-desktop (VNC/RDP) connections' as part of the release without the experimental qualifier the README uses (README.md:104). This is separate from MKT-011, which is about internal entries dominating the changelog.

## Why it matters

A visitor who opens CHANGELOG.md sees a release dated almost three months ago that cannot be downloaded. That looks like an abandoned or broken release process. It also promises remote desktop with no qualifier, while the app hides it behind a toggle.

## Evidence

- `CHANGELOG.md:17`
- `CHANGELOG.md:19`
- `README.md:104`

## Recommendation

Change the header to `## [0.1.0] - Unreleased` (or fold the block into [Unreleased]) until the tag is cut, and have release-check.sh stamp the real date. Add '(experimental)' after remote desktop in the intro line.

## Verification

Confirmed. CHANGELOG.md:17 reads '## [0.1.0] - 2026-07-20', and no v0.1.0 tag exists in the checkout (git tag -l 'v0.1\*' is empty). The intro line lists remote-desktop (VNC/RDP), embedded servers and network diagnostics with no experimental qualifier.
