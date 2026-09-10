---
id: DOC-012
title: CHANGELOG 0.1.0 is uncurated dev-churn (contradicts the documented curation process); Version-Bump step lists 4 files but commits 3
angle: docs-accuracy
severity: low
category: docs
is_workaround: false
subsystem: CHANGELOG/contributing
evidence:
  - CHANGELOG.md:17
  - docs/contributing.md:932
  - docs/contributing.md:919
  - docs/contributing.md:974
status: open
---

## What

Two adjacent release-process doc/artifact inconsistencies:

1. **CHANGELOG contradicts its own curation rule.** `docs/contributing.md` "Finalize Changelog"
   mandates curation — "Collapse intermediate `develop`-only churn … write the single net entry …
   not the development path". But the `[0.1.0]` section in `CHANGELOG.md` is the opposite: long,
   granular, per-PR internal entries like "Testing: ported the Windows-shells & WSL infrastructure
   suite to the Python bridge harness (#975 …)" — exactly the development-path churn the process
   says to remove. So the released changelog does not follow the documented process.
2. **Version-Bump file list vs commit list mismatch.** The "Version Bump" step says to update the
   version in **four** files (`package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`,
   `agent/Cargo.toml`), but the "Commit, Tag, and Push" `git add` command stages only three
   (`package.json src-tauri/Cargo.toml src-tauri/tauri.conf.json CHANGELOG.md`) — it omits
   `agent/Cargo.toml`. A releaser copy-pasting the commit block would leave the agent version bump
   uncommitted.

## Why it matters

The changelog is the user-facing release notes; shipping raw internal test-porting entries under a
version heading is both noise for users and evidence the curation step was skipped. The version-bump
omission risks an agent/desktop version mismatch slipping into a release. Both are low-severity but
land on the release hot path.

## Evidence

- `CHANGELOG.md:17-` — `## [0.1.0] - 2026-07-20` followed by granular per-PR "Testing: …" entries.
- Curation rule: `docs/contributing.md:932-944` (esp. "Collapse intermediate `develop`-only churn").
- Four-file list: `docs/contributing.md:919-924`; three-file commit: `docs/contributing.md:974`
  (`git add package.json src-tauri/Cargo.toml src-tauri/tauri.conf.json CHANGELOG.md` — no
  `agent/Cargo.toml`).

## Recommendation

Add `agent/Cargo.toml` to the `git add` in the Commit step. Before release, run the documented
curation over `docs/changes/` fragments so the `[0.1.0]` section reads as net user-facing changes,
not the dev path (or, if the current `[0.1.0]` content is a pre-release placeholder, note that).
`scripts/release-check.sh` validates version consistency across the four files — worth citing here.
