---
id: PKG2-007
title: "The Windows ARM64 agent release build (aarch64-pc-windows-msvc, +crt-static) is first compiled at tag time; Dev Build, which the release gate relies on for 'agent binaries', builds no Windows agents"
angle: packaging-release
severity: low
category: release-gating
is_workaround: false
subsystem: ".github/workflows (release gate coverage)"
evidence:
  - .github/workflows/release.yml:856-859
  - .github/workflows/release.yml:881-884
  - .github/workflows/agent.yml:170-173
  - .github/workflows/dev-build.yml:442
  - .github/workflows/dev-build.yml:518
  - docs/contributing.md:1462
  - scripts/internal/release-integration-gate.mjs:58
status: fixed
resolution: "#4302 — dev-build.yml builds windows-x64 and windows-arm64 agents (static CRT + vcruntime check) before tag time"
audit: 2026-10
commit: 663465d52
relation: new
---

## What

release-integration-gate.mjs requires a green Dev Build on the release SHA, which docs/contributing.md:1462 describes as 'the full app build on all five platforms plus the agent binaries (CI-015)'. Dev Build only builds the 3 Linux and 2 macOS agents. The Windows x64 agent is built post-merge in agent.yml (not part of the gate). The aarch64-pc-windows-msvc agent with static CRT is never built anywhere except release.yml's agent-binaries-windows job. Code Quality cross-builds only the rdp-sidecar and plugin-runner for ARM64 Windows, in debug.

## Why it matters

A dependency or toolchain change that breaks the ARM64 Windows MSVC link is discovered only after create-release has published the release. verify-release then fails and the tag has to be re-cut, which is exactly the failure class the integration gate was added to prevent.

## Evidence

- `.github/workflows/release.yml:856-859`
- `.github/workflows/release.yml:881-884`
- `.github/workflows/agent.yml:170-173`
- `.github/workflows/dev-build.yml:442`
- `.github/workflows/dev-build.yml:518`
- `docs/contributing.md:1462`
- `scripts/internal/release-integration-gate.mjs:58`

## Recommendation

Add windows-x64 and windows-arm64 agent legs (same RUSTFLAGS crt-static + verify-no-vcruntime) to dev-build.yml. That also fills the missing dev-release Windows agents. Alternatively, add agent.yml's Windows build, extended with the arm64 target, to the gate's required runs. Correct the docs/contributing.md:1462 wording to match.

## Verification

Confirmed. Dev Build's agent matrix has only the Linux musl and macOS targets, with no Windows agent. aarch64-pc-windows-msvc appears only in release.yml, release-windows-arm64-smoke.yml (post-release) and code-quality.yml. The code-quality legs build the rdp-sidecar and plugin-runner scripts with stub cargo in debug, not the agent. contributing.md:1462 claims Dev Build covers 'the agent binaries'. So the Windows arm64 agent link is first exercised at tag time.
