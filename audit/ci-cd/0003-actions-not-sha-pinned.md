---
id: CI-003
title: Third-party GitHub Actions are not SHA-pinned
angle: ci-cd
severity: high
category: supply-chain
is_workaround: false
subsystem: .github/workflows
evidence:
  - .github/workflows/release.yml:194
  - .github/workflows/code-quality.yml:52
  - .github/workflows/build.yml:53
  - .github/actions/setup-pnpm/action.yml:12
status: fixed
resolution: "#2753 — actions SHA-pinned"
---

## What
Every third-party (and first-party marketplace) action across the workflows is referenced by a
**mutable tag**, not a commit SHA:

- `tauri-apps/tauri-action@v0` (`release.yml:194`, `dev-build.yml:147`) — builds and signs the
  **shipped installers**.
- `dtolnay/rust-toolchain@stable` / `@1.98.0` — `@stable` is a moving ref (see CI-005).
- `Swatinem/rust-cache@v2`, `taiki-e/install-action@v2`, `astral-sh/setup-uv@v6`,
  `pnpm/action-setup@v6`, `actions/checkout@v6` (and `@v4` in auto-close), `actions/setup-node@v6`,
  `actions/upload-artifact@v4/@v7`, `actions/download-artifact@v8`.

A tag can be force-moved by the action owner (or by an attacker who compromises the repo) to point
at malicious code, which then runs in CI with the workflow's token and, for the build/release
workflows, with write access to the released artifacts.

## Why it matters
This is the CI's own supply chain. `tauri-action` and `taiki-e/install-action` download and execute
tooling that produces the binaries users install; a compromised or retagged version could inject
into the shipped app of a safety-critical product with no diff on the PR. Tag pinning gives zero
protection against tag mutation; SHA pinning does. GitHub's own hardening guidance for security-
sensitive pipelines is to pin actions to full-length commit SHAs.

## Evidence
`grep -rn "uses:" .github/workflows` shows only `@vN`/`@stable` refs; no `@<40-hex-sha>` anywhere.

## Recommendation
Pin every `uses:` to a full commit SHA with the tag in a trailing comment (e.g.
`tauri-apps/tauri-action@<sha> # v0.5.x`). Adopt Dependabot's `github-actions` ecosystem to bump the
SHAs on a reviewed cadence. Prioritise the build/release/agent workflows first (they touch shipped
artifacts). Keep the first-party `actions/*` on SHAs too — they are not exempt.
