---
id: CI2-008
title: "Agent cross-build workflow path filter is narrower than the agent's real inputs (Cargo.lock, vendor/, plugin-api/, toolchain)"
angle: ci-cd
severity: low
category: test-gap
is_workaround: false
subsystem: .github/workflows/agent.yml
evidence:
  - .github/workflows/agent.yml:12
  - .github/workflows/agent.yml:23
  - .github/workflows/agent.yml:82
  - scripts/internal/ci-changes.mjs:109
  - scripts/internal/ci-changes.mjs:110
  - core/Cargo.toml:110
  - core/Cargo.toml:151
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: new
---

## What

agent.yml's workflow-level `paths` filter (pull_request and push) is agent/**, core/**, Cargo.toml, the workflow file and one script. The agent compiles from more than that: Cargo.lock, vendor/ (vnc-rs is a core path dep), plugin-api/ and plugin-runner/, .cargo/, and the pinned toolchain (.github/rust-version, .github/actions/setup-rust). The shared classifier already models this, since AGENT_ROOTS/AGENT_FILES include those paths and build-linux gates on `agent != 'false'`. But the workflow never starts for them.

## Why it matters

The musl x64/arm64/armv7 cross-builds are the only pre-merge check of the 32-bit/musl agent targets. A lockfile bump (the cargo-update chore, a dependabot-style PR) or a vendor/toolchain change that breaks armv7 or musl merges green. It then reds develop's Dev Build, which the release gate requires, and blocks other work. The post-merge Windows/macOS legs that warm agent-live-windows' cache are skipped too.

## Recommendation

Drop the workflow-level `paths` filter and rely on the job-level `agent` area gate, which is already fail-open and comment-aware. Or extend `paths` to match AGENT_ROOTS/AGENT_FILES plus `.github/rust-version` and `.github/actions/setup-rust/**`, and add a test that keeps the two lists in sync.

## Verification

Confirmed. agent.yml's paths filter is agent/**, core/**, Cargo.toml, the workflow file and one script. ci-changes.mjs AGENT_ROOTS/AGENT_FILES also include Cargo.lock, vendor/, plugin-api/, plugin-runner/ and .cargo/, and core depends on ../vendor/vnc-rs and ../plugin-api via path. A lockfile or vendor change therefore skips the musl/armv7 cross-builds before merge. Impact is bounded: dev-build on develop builds the agents post-merge and catches the break within one run, and the lockfile chore that would generate such PRs is not running. Severity is low rather than medium.
