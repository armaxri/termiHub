# Release Process

This document describes how to create a new TermiHub release.

## Pre-Release Checklist

Before creating a release, run the quality scripts and verify:

```bash
./scripts/test.sh      # All unit tests (frontend + backend + agent)
./scripts/check.sh     # Formatting, linting, clippy (mirrors CI)
```

- [ ] All scripts pass without errors
- [ ] `CHANGELOG.md` has been updated with all user-facing changes
- [ ] No known release-blocking issues remain

## Version Bump

Update the version number in all four locations:

1. **`package.json`** — `"version": "X.Y.Z"`
2. **`src-tauri/Cargo.toml`** — `version = "X.Y.Z"`
3. **`src-tauri/tauri.conf.json`** — `"version": "X.Y.Z"`
4. **`agent/Cargo.toml`** — `version = "X.Y.Z"`

Use [Semantic Versioning](https://semver.org/):
- **MAJOR** (X): Breaking changes
- **MINOR** (Y): New features, backwards-compatible
- **PATCH** (Z): Bug fixes, backwards-compatible

## Finalize Changelog

Move the `[Unreleased]` section to a versioned section:

```markdown
## [Unreleased]

## [X.Y.Z] - YYYY-MM-DD

### Added
- ...

### Fixed
- ...
```

## Commit, Tag, and Push

```bash
# Commit the version bump and changelog
git add package.json src-tauri/Cargo.toml src-tauri/tauri.conf.json CHANGELOG.md
git commit -m "chore: release vX.Y.Z"

# Create an annotated tag
git tag -a vX.Y.Z -m "Release vX.Y.Z"

# Push commit and tag
git push origin main
git push origin vX.Y.Z
```

Pushing the `vX.Y.Z` tag triggers the [Release workflow](../.github/workflows/release.yml), which will:

1. Create a GitHub Release with notes extracted from `CHANGELOG.md`
2. Build platform-specific installers (macOS .dmg, Windows .msi, Linux .AppImage + .deb)
3. Upload all artifacts to the GitHub Release page
4. Update the `latest` tag

## Post-Release Verification

After the workflow completes:

- [ ] Check the [GitHub Actions](https://github.com/armaxri/termiHub/actions) page — all jobs should be green
- [ ] Visit the [Releases page](https://github.com/armaxri/termiHub/releases) — verify the release exists with correct notes
- [ ] Confirm all platform artifacts are attached (macOS x64, macOS ARM64, Windows x64, Linux x64, Linux ARM64)
- [ ] Download and smoke-test at least one artifact on your platform

## Hotfix Process

For urgent bug fixes on a released version:

1. Create a branch from the release tag: `git checkout -b bugfix/description vX.Y.Z`
2. Fix the bug and add tests
3. Bump the patch version (e.g., `X.Y.Z` → `X.Y.Z+1`)
4. Update `CHANGELOG.md`
5. Merge to `main` via PR
6. Tag and push (same process as above)
