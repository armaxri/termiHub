---
id: SUP2-005
title: "Daily cargo-update chore auto-merges freshly published crate versions with no release-age cooldown or human review"
angle: supply-chain
severity: low
category: supply-chain
is_workaround: false
subsystem: "workspace / cargo-update-lockfile"
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: new
evidence:
  - .github/workflows/cargo-update-lockfile.yml:36
  - .github/workflows/cargo-update-lockfile.yml:85
  - .github/workflows/cargo-update-lockfile.yml:110
  - .github/workflows/cargo-update-lockfile.yml:228
---

## What

Every day at 04:00 the chore runs a blanket `cargo update`, which can move every semver-compatible crate in an 888-package graph. If cargo deny passes, it enables `gh pr merge --auto --merge`. cargo deny checks only known advisories, yanks, licenses and sources. It cannot detect a malicious patch release published hours earlier, because RUSTSEC entries arrive only after detection. The workflow applies no minimum package age and no review step, and the lockfile diff is summarised only as `git diff --stat`.

## Why it matters

Most recent registry supply-chain compromises (malicious patch releases of popular transitive crates and packages) are found within days. A zero-cooldown, auto-merged lockfile refresh is the fastest path for such a release into develop, and from there into the next tag. The maintainer's decision (#3291) was about clearing yanks quickly. A short age floor does not conflict with that goal: yank fixes are almost always older than a day, and the per-crate runbook path still exists for urgent advisory fixes.

## Recommendation

After `cargo update`, compute the changed name@version set from the Cargo.lock diff and query the crates.io API for each version's created_at. Revert, or leave unmerged, any version younger than N days (for example 3), and print a per-crate version-change table in the PR body instead of only --stat. Keep auto-merge only when every bump passes the age floor. Exempt bumps whose purpose is an advisory or yank fix (listed in the runbook).

## Verification

Confirmed. A daily blanket `cargo update` runs, then cargo deny, then `gh pr merge --auto --merge`, with only `git diff --stat` in the summary and no age floor or review. The daily cadence is a deliberate maintainer decision about yanks, but no doc addresses the risk of freshly published malicious releases. It is a hardening gap, not a defect: PR CI still runs and auto-merge depends on the repo setting. Low.
