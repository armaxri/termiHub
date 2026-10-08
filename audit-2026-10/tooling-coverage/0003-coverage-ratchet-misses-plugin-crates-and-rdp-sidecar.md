---
id: TOOL2-003
title: "Coverage ratchet has no per-component gate for plugin-runner/plugin-api and does not measure rdp-sidecar at all"
angle: tooling-coverage
severity: medium
category: coverage
is_workaround: false
subsystem: "coverage tooling"
evidence:
  - "scripts/internal/coverage-ratchet.mjs:42-48"
  - "scripts/coverage-baseline.json:1-19"
  - "scripts/coverage.sh:91-95"
  - "Cargo.toml:workspace.members"
  - "rdp-sidecar/src/main.rs:4-6"
  - ".github/workflows/code-quality.yml:325-375"
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: previous-incomplete
previous_id: TOOL-003
---

## What

`COMPONENTS`/`DIR_TO_COMPONENT` in coverage-ratchet.mjs gate only frontend, core, agent and src-tauri, plus 'unified'. plugin-runner (new, ~11k lines, the plugin sandbox) and plugin-api only feed the unified total, where a collapse in either is diluted by the much larger core, frontend and src-tauri line counts and stays under the 0.25 pp tolerance.

`coverage.sh` runs `cargo llvm-cov --workspace`. rdp-sidecar is deliberately excluded from the workspace and has its own lockfile, so its ~11.5k lines are never instrumented: no coverage number, no lcov, no ratchet. Its only test gate is a plain `cargo test --locked` in rdp-sidecar-quality, and that job runs only when rdp-sidecar/\*\* changes.

## Why it matters

The flagship 'full-coverage, unified, gated before release' capability has a blind spot over the two newest security-relevant Rust components. A plugin-runner test suite could be deleted or cfg'd out, and the ratchet would still pass. The 'unified' number overstates whole-app coverage because it leaves out an entire shipped binary.

## Evidence

- `scripts/internal/coverage-ratchet.mjs:42-48`
- `scripts/coverage-baseline.json:1-19`
- `scripts/coverage.sh:91-95`
- `Cargo.toml:workspace.members`
- `rdp-sidecar/src/main.rs:4-6`
- `.github/workflows/code-quality.yml:325-375`

## Recommendation

Add `"plugin-runner": "plugin-runner"` and `"plugin-api": "plugin-api"` to DIR_TO_COMPONENT/COMPONENTS and seed their baselines with `--update-baseline`. In coverage.sh (and coverage.cmd), add a second `cargo llvm-cov --no-report` pass with `--manifest-path rdp-sidecar/Cargo.toml` that emits an `rdp-sidecar.lcov`, concatenate it into UNIT_LCOV, and gate it as its own `rdp-sidecar` component. Optionally, have the ratchet fail when a workspace member or known shipped crate dir has zero records in the lcov, so the next new crate cannot fall out silently.

## Verification

Confirmed. coverage-ratchet.mjs COMPONENTS is [frontend, core, agent, src-tauri, unified] and DIR_TO_COMPONENT has no plugin-runner or plugin-api entry. coverage-baseline.json gates only those five per platform. coverage.sh runs `cargo llvm-cov --workspace` only and never mentions rdp-sidecar, which is excluded from the workspace, so its code is never instrumented. One detail in the finding is overstated: the rdp-sidecar-quality job runs on every post-merge build and is conditional only in the PR lane (code-quality.yml:323). The workspace exclusion exists for lockfile reasons, not as a coverage decision. Medium.
