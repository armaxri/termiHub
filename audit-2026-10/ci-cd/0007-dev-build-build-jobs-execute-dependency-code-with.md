---
id: CI2-007
title: "dev-build build jobs execute dependency code with a contents:write token persisted in .git/config"
angle: ci-cd
severity: low
category: security
is_workaround: false
subsystem: .github/workflows/dev-build.yml
evidence:
  - .github/workflows/dev-build.yml:18
  - .github/workflows/dev-build.yml:19
  - .github/workflows/dev-build.yml:44
  - .github/workflows/dev-build.yml:145
  - .github/workflows/dev-build.yml:187
  - .github/workflows/release.yml:278
  - .github/workflows/release.yml:368
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: new
---

## What

dev-build.yml sets workflow-level `permissions: contents: write`. build-app and build-agents-\* do not narrow it, even though they only build and upload artifacts: tauri-action is called with tagName '' (no release upload), and publishing happens in `publish-release`. These jobs run `pnpm install --frozen-lockfile` with lifecycle scripts enabled, plus every crate's build.rs, after an actions/checkout with default persist-credentials:true. release.yml build-and-upload is similar: it needs write for `gh release upload`, but it also runs `pnpm install` with scripts enabled.

## Why it matters

A compromised npm or crates.io dependency executing in these jobs gets a repo-write GITHUB_TOKEN. develop has no required checks or PR requirement live (see the CI-017 finding), so it could push directly to develop or replace dev and release assets. The 'least privilege' fix for CI-010 covered only the unscoped workflows.

## Recommendation

In dev-build.yml set the workflow default to `contents: read` and grant `contents: write` only to `publish-release`. Add `persist-credentials: false` to build-job checkouts. In release.yml, split build-and-upload into a read-only build job that uploads an artifact and a small write-scoped upload job, or at least run `pnpm install --ignore-scripts` where feasible.

## Verification

Confirmed. dev-build.yml sets workflow-level contents:write (line 18) and its build jobs do not narrow it. tauri-action runs with tagName '' and `pnpm install --frozen-lockfile` runs with scripts enabled. Exposure is limited: dev-build triggers only on push to main/develop (no PR or fork code), so only dependencies already merged into the lockfile execute. That makes this least-privilege hardening against a compromised dependency, not a directly exploitable path. I could not verify the claim that develop has no branch protection.
