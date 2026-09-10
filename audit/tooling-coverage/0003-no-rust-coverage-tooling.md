---
id: TOOL-003
title: No Rust coverage tooling or gate despite a documented >80% target
angle: tooling-coverage
severity: high
category: tooling
is_workaround: false
subsystem: rust / coverage
evidence:
  - docs/testing.md:393
  - .github/workflows/code-quality.yml:210
  - Cargo.toml:1
status: open
---

## What

There is no Rust coverage measurement anywhere: no `cargo-llvm-cov`, no
`cargo-tarpaulin`, no coverage step in any workflow, no `Cargo.toml` coverage
config. The Rust backend (`src-tauri`), the agent (`agent`), and the shared core
(`core` — the safety-critical session/transport/backends code) are entirely
unmeasured. Meanwhile `docs/testing.md` states a **">80% Rust line coverage"**
goal, so the project has a target it cannot see or enforce.

## Why it matters

The Rust crates are the ventilator-grade hot path: session lifecycle, PTY/SSH
transport, credential encryption, agent reconnect. These are exactly where an
untested branch is most dangerous, and they are the part of the app with **no
coverage signal at all**. The stated 80% goal is aspirational fiction until a tool
measures it. Without this, the unified whole-app number (TOOL-001) is impossible.

## Evidence

- `docs/testing.md:393` — "Coverage Goals … Rust Backend: >80% line coverage" with
  no measuring tool.
- `.github/workflows/code-quality.yml` — the `tests` matrix runs
  `cargo test --workspace --all-features` (line ~210) but never with coverage
  instrumentation.
- No `llvm-cov`/`tarpaulin`/`grcov` reference exists in `Cargo.toml`, `scripts/`, or
  `.github/workflows/` (grepped).

## Recommendation

Adopt **`cargo-llvm-cov`** (source-based coverage, works across the whole workspace
with `--all-features`, integrates with the existing `cargo test`, and emits `lcov`
for merging with the frontend):

```bash
cargo llvm-cov --workspace --all-features --lcov --output-path rust.lcov
```

Install it in CI via `taiki-e/install-action` (already used for `cargo-audit`/
`cargo-deny`, so the pattern is in place). Start with a report + advisory threshold,
then ratchet to a blocking floor. Also run the **nightly integration lane** under
`cargo-llvm-cov` so Docker-fixture-dependent tests contribute (they are the only
coverage for several backends). Feed the lcov into the unified gate (TOOL-001).
Prefer `cargo-llvm-cov` over `tarpaulin` for accuracy and cross-platform support.
