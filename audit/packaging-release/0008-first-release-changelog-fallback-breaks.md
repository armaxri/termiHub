---
id: PKG-008
title: Release-notes generation's commit fallback breaks on the first tag (git describe has no prior tag)
angle: packaging-release
severity: medium
category: reliability
is_workaround: false
subsystem: .github/workflows/release.yml
evidence:
  - .github/workflows/release.yml:28
  - .github/workflows/release.yml:40
status: open
---

## What
The `Generate changelog` step first tries to extract a `## [VERSION]` section from
`CHANGELOG.md`. If that comes back empty, it falls back to generating notes from git
history:

```
CHANGELOG=$(git log $(git describe --tags --abbrev=0 HEAD^)..HEAD --pretty=format:"- %s (%h)" --no-merges)
```

For the **first ever release** (`v0.1.0`, the current target) there is no prior tag, so
`git describe --tags --abbrev=0 HEAD^` exits non-zero / prints nothing, and the
`git log <bad-range>..HEAD` command fails. The step has no `set -e` guard visible but a
failed command substitution yields a broken range and a non-zero `git log`, which can
fail the step or emit empty notes.

## Why it matters
v0.1.0 is precisely the case that hits this path. If `CHANGELOG.md` lacks a properly
dated `## [0.1.0] - YYYY-MM-DD` section (the extraction returning empty is what
triggers the fallback), the release either fails at notes generation or publishes with
empty notes — and `verify-release` explicitly fails on empty notes
(`release.yml:542-546`), so the whole release job aborts after artifacts are already
built. A turnkey one-tag release should not depend on this fragile fallback for its
first run.

## Evidence
- `release.yml:28-44` — the changelog extraction + `git describe`-based fallback.
- `release.yml:542-546` — `verify-release` hard-fails on empty release notes, so a
  failed fallback surfaces late.
- `scripts/release-check.sh:61-65` — separately requires a dated `## [VERSION]`
  section, i.e. the CHANGELOG is *expected* to carry it — but nothing in the tag
  workflow enforces that before the fallback is reached.

## Recommendation
Guard the fallback for the no-prior-tag case: if `git describe --tags --abbrev=0
HEAD^` fails, fall back to `git log <root>..HEAD` (or the full history) instead of an
invalid range. Better, make a dated `CHANGELOG.md` section a **precondition** of the
release (fail fast in the `verify-version` job from PKG-007 if `## [<tag>] -
<date>` is absent) so the commit fallback is never needed for a real release and the
release notes are deterministic.
