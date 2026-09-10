---
id: CI-010
title: GITHUB_TOKEN not least-privilege — most workflows omit a permissions block
angle: ci-cd
severity: medium
category: security
is_workaround: false
subsystem: .github/workflows
evidence:
  - .github/workflows/code-quality.yml:1
  - .github/workflows/build.yml:1
  - .github/workflows/system-integration.yml:1
  - .github/workflows/agent.yml:1
status: open
---

## What
Six workflows declare no top-level `permissions:` block: `code-quality.yml`, `build.yml`,
`system-integration.yml`, `agent.yml`, `integration-fixtures.yml`, and both
`agent-integration-windows-*-grade.yml`. Without an explicit block the `GITHUB_TOKEN` inherits the
repository/organization **default** token permissions, which for many repos is read/write across
all scopes. The workflows that *do* scope the token (`release`, `dev-build`, `auto-close-issues`,
`cargo-update-lockfile`, `agent-cleanup`, both release-smoke) show the intended pattern.

## Why it matters
These unscoped workflows run untrusted-adjacent code (PR builds, third-party actions, cargo build
scripts, a full app under test) with a token more powerful than they need. If any step or dependency
is compromised, the blast radius is whatever the repo default grants (potentially `contents: write`,
`packages: write`, etc.) rather than the read-only these jobs actually require. Least-privilege is
the standard hardening for exactly this.

## Evidence
`grep -L '^permissions:' .github/workflows/*.yml` → the six files above. None of them push, release,
or comment, so they need only `contents: read`.

## Recommendation
Set the org/repo default token permission to read-only (Settings → Actions → Workflow permissions),
and add an explicit `permissions: { contents: read }` to every workflow, elevating only the specific
scope each job needs (as `release`/`auto-close` already do). This is a small, mechanical change with
a large reduction in blast radius.
