---
id: TOOL-010
title: No lint enforces the "no .unwrap() in production Rust" policy
angle: tooling-coverage
severity: medium
category: tooling
is_workaround: false
subsystem: rust / static-analysis
evidence:
  - .claude/CLAUDE.md:1
  - .github/workflows/code-quality.yml:200
status: fixed
resolution: "#3224 — no-panic-in-prod policy now lint-enforced: #![cfg_attr(not(test), deny(clippy::unwrap_used, expect_used, panic))] on all 4 first-party crate roots (core/agent/src-tauri/plugin-api); CI's clippy -D warnings gates new violations. All 28 existing prod violations fixed behavior-preservingly (agent dispatch via to_result_value, runtime/main return anyhow::Result, mutex poison-recovery, typed TerminalError propagation). Lint confirmed firing. Test/vendored/example code exempt via not(test)"
---

## What

The coding standards state plainly: *"No `.unwrap()` in production code — use `?`
with `anyhow::Result`."* But nothing enforces it. Clippy runs with
`-D warnings` on the **default** lint set, which does **not** include
`clippy::unwrap_used` / `clippy::expect_used` / `clippy::panic` (those are in the
`restriction` group, off by default). There is no `clippy.toml`, no
`#![warn(clippy::unwrap_used)]` crate attribute, and no `deny.toml`-style lint
policy. So an `.unwrap()` on a real path compiles clean and passes CI.

## Why it matters

`unwrap()` on a real path is a panic — on a ventilator-grade terminal hub that means
a crash on a live session. The workaround-rust audit angle is hunting these by hand
precisely because no tool surfaces them. A lint would convert an entire class of
release-blocking defects from "find by manual review" into "CI fails the PR that
introduced it," and would prevent regressions after the manual sweep is done.

## Evidence

- Policy: `.claude/CLAUDE.md` → Rust section, "No `.unwrap()` in production code".
- `.github/workflows/code-quality.yml` → `cargo clippy --workspace --all-targets
  --all-features -- -D warnings` — default lints only; `unwrap_used` is a
  `restriction`-group lint not enabled here.

## Recommendation

Enable the restriction lints where they belong (production crates, not tests):

- Add `#![cfg_attr(not(test), warn(clippy::unwrap_used, clippy::expect_used,
  clippy::panic))]` (or `deny` once clean) to `core`, `src-tauri`, and `agent` crate
  roots — scoping to `not(test)` keeps tests free to `unwrap`.
- Alternatively drive it centrally from CI: `cargo clippy … -- -D warnings
  -W clippy::unwrap_used …`. Land advisory first to enumerate existing sites
  (feeds the workaround-rust cleanup), fix them, then flip to deny so it stays clean.
- Consider `clippy::todo` / `clippy::unimplemented` in the same pass to catch stub
  panics before release.
