---
id: WA-CI2-004
title: "develop has no required status checks live, so 'PR Gate' is advisory, and the lockfile bot recommends auto-merge on PRs that trigger no CI"
angle: workaround-ci-scripts
severity: medium
category: masked-gate
is_workaround: false
subsystem: ci/branch-protection
audit: 2026-10
commit: 663465d52
relation: new
evidence:
  - .github/branch-protection.json:98-122
  - .github/workflows/code-quality.yml:1466-1509
  - .github/workflows/cargo-update-lockfile.yml:58
  - .github/workflows/cargo-update-lockfile.yml:156-166
  - .github/workflows/cargo-update-lockfile.yml:225-236
status: open
resolution: ""
---

## What

Live `GET /branches/develop/protection` returns no `required_status_checks` and no `required_pull_request_reviews`; only force-push and deletion are blocked. The committed expectation still marks develop as `"status": "proposed"`. The aggregate PR Gate (#3678), built specifically so it can be a required check, therefore gates nothing on the integration branch. Every merge to develop is protected only by the merger choosing to wait for green. The drift workflow that would report this cannot run (not on main). Separately, cargo-update-lockfile.yml pushes and opens its PR with GITHUB_TOKEN. Its own body says such PRs trigger no workflows. It then runs `gh pr merge --auto --merge` and tells the maintainer that enabling repo auto-merge makes it 'fully hands-off'. Repo auto-merge is currently off (allow_auto_merge=false).

## Why it matters

The headline question for this angle is which gates actually gate. On develop, none do: a red or never-run PR Gate can be merged with one click, by a human or an automation. If the maintainer follows the bot's advice and enables auto-merge while develop has no required checks, the daily lockfile PR has nothing to wait for. Its only pre-merge check is the in-job cargo-deny; no build or test has run. It would merge a dependency bump untested.

## Recommendation

Apply the proposed protection: `scripts/internal/apply-branch-protection.sh --branch develop --apply`, then flip develop to "enforced" in .github/branch-protection.json. That puts PR Gate and the listed contexts in force. In cargo-update-lockfile.yml, push and open the PR with a GitHub App or fine-grained token so CI triggers. Or keep the GITHUB_TOKEN path but drop the auto-merge recommendation and the `--auto` call until develop has required checks.

## Verification

Confirmed. Live develop protection has no required_status_checks and no required_pull_request_reviews keys. branch-protection.json marks develop as 'proposed', so PR Gate is advisory. cargo-update-lockfile.yml opens its PR with GITHUB_TOKEN, and its own body admits that such PRs trigger no workflows. It then calls `gh pr merge --auto --merge` and tells the maintainer that enabling auto-merge makes it 'fully hands-off'. allow_auto_merge is currently false, so the auto-merge risk is latent. Enforcing develop protection is a known pending maintainer step, but the bot's advice would, if followed, let an untested lockfile bump merge. Medium.
