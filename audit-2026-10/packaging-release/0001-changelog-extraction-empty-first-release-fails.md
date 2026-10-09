---
id: PKG2-001
title: "CHANGELOG extraction in release.yml always comes back empty; the first release falls back to full history, which is over GitHub's release-body limit, so create-release fails (and the security marker can never fire from CHANGELOG)"
angle: packaging-release
severity: high
category: reliability
is_workaround: false
subsystem: ".github/workflows/release.yml (create-release)"
evidence:
  - .github/workflows/release.yml:178
  - .github/workflows/release.yml:181-193
  - .github/workflows/release.yml:199-211
  - .github/workflows/release.yml:263-267
  - CHANGELOG.md:17
  - scripts/release-check.sh:322
  - scripts/internal/emit-release-notes.mjs
status: fixed
resolution: "#4278 — release notes come from a tested script that extracts the exact CHANGELOG section and caps the body under GitHub's limit"
audit: 2026-10
commit: 663465d52
relation: regression
previous_id: PKG-008
---

## What

`awk "/## \[${VERSION}\]/,/## \[/" CHANGELOG.md` is an awk range whose end pattern (`## [`) also matches the start line. In awk, when the start record also matches the end pattern, the range is just that one line. The output is therefore only the `## [0.1.0] - 2026-07-20` header, and `sed '$d'` deletes it, so CHANGELOG is always empty. I ran the command on this tree: 1 line, i.e. empty. The workflow then always takes the git-log fallback. For the first tag there is no previous tag, so RANGE=HEAD covers all 7,840 non-merge commits, about 642 KB of notes (measured with the same `git log` format). GitHub rejects a release body over 125,000 characters, so `gh release create` (line 263) fails and no release is created. On later releases the notes are still a raw commit dump instead of the curated CHANGELOG section. emit-release-notes.mjs looks for a `### Security` heading in those notes, so a security release is never auto-marked from CHANGELOG (only the TERMIHUB_SECURITY_RELEASE variable works). release-check.sh:322 uses sed for its range, which is why the manual check passes while the workflow fails.

## Why it matters

The fix for PKG-008 removed the git-describe crash but did not make the first release work: v0.1.0 cannot be published from a tag push. The broken extraction also defeats two documented behaviours: release notes taken from CHANGELOG, and auto-marking security releases so the desktop drops 'Skip this version' (#1878).

## Evidence

- `.github/workflows/release.yml:178`
- `.github/workflows/release.yml:181-193`
- `.github/workflows/release.yml:199-211`
- `.github/workflows/release.yml:263-267`
- `CHANGELOG.md:17`
- `scripts/release-check.sh:322`
- `scripts/internal/emit-release-notes.mjs`

## Recommendation

Move the extraction into a tested script, e.g. add an `extractSection(changelog, version)` to emit-release-notes.mjs with unit tests. Or use sed the same way release-check.sh:322 does: `sed -n "/^## \[${VERSION//./\\.}\]/,/^## \[/{/^## \[/d;p;}" CHANGELOG.md`. Also cap the fallback: for a first release, emit a short summary plus a compare link instead of the full history, and fail early with a clear error if the notes exceed about 120k characters. Add a CI test that runs the extraction against the real CHANGELOG.md for the current package.json version.

## Verification

Confirmed in /Users/arne/work/git/termiHubDev/dev9/termiHub, and I found no guard elsewhere.

**The extraction is always empty.** release.yml:178 runs `awk "/## \[${VERSION}\]/,/## \[/"`. The end pattern also matches the start line, so the range is that one line.

- With VERSION=0.1.0 (the version in package.json), awk printed 1 line.
- After `sed '$d' | tail -n +2`, the result was 0 bytes.
- CHANGELOG.md:17 does contain a full, populated `## [0.1.0] - 2026-07-20` section. The extraction just never reads it.

**The fallback produces notes that are far too long.** Because the extraction is empty, the workflow always uses the git-log fallback.

- The create-release checkout uses `fetch-depth: 0` (line 144), so the runner has the full history.
- There is no prior `v*` tag (only dev-latest and dev-develop-latest exist), so RANGE=HEAD.
- I ran the same `git log --pretty=format:"- %s (%h)" --no-merges`: 7,840 commits and 642,378 bytes.
- GitHub's release-body limit is 125,000 characters. Nothing caps or truncates release_notes.md, so `gh release create` (line 263) is rejected and v0.1.0 cannot be published from a tag push.

**The security marker can never fire from the CHANGELOG.** emit-release-notes.mjs only looks for a `### Security` heading in the notes it is given, and those are always the git-log dump. Only the TERMIHUB_SECURITY_RELEASE variable can trigger it.

**Why the manual check passes.** release-check.sh only greps for the dated header. Its sed range (line 322) uses delete-on-match, so it does not hit the awk problem.

**No deliberate decision covers this.** The comments around PKG-008 show the full-history fallback was meant to stop the crash, not to produce a body this large.

**Severity: high.** It blocks the immediate v0.1.0 milestone and hides the curated notes. It does fail loudly and before anything is built or published, and the fix is easy, so medium would also be defensible. High fits because it is a certain release blocker.
