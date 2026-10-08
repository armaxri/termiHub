---
id: TBE2-005
title: "The coverage ratchet does not gate the plugin-runner sandbox crate"
angle: test-backend
severity: low
category: test-infrastructure
is_workaround: false
subsystem: coverage ratchet / plugin-runner
evidence:
  - scripts/internal/coverage-ratchet.mjs:42
  - scripts/internal/coverage-ratchet.mjs:43
  - scripts/internal/coverage-ratchet.mjs:61
  - scripts/coverage-baseline.json:4
  - Cargo.toml:9
  - plugin-runner/src/runner/mod.rs:284
  - plugin-runner/src/runner/shim.rs:1
  - plugin-runner/src/loader/mod.rs:336
  - core/tests/plugin_runner_support/mod.rs:42
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: new
---

## What

The TBE-007 ratchet grades only `frontend`, `core`, `agent` and `src-tauri` (`DIR_TO_COMPONENT`, coverage-ratchet.mjs:42-48). `plugin-runner/` (added in #4182; the sandbox, IPC and loader security boundary) and `plugin-api/` map to `null` and count only toward `unified`, where vendor/vnc-rs and the frontend dilute them. Several large runner modules have no unit tests at all: runner/mod.rs (545 lines: handshake, session server, teardown), runner/shim.rs (218), loader/mod.rs (497) and sandbox/macos.rs (155). The process-level tests do not fill the gap, because core/tests builds the runner into a private `CARGO_TARGET_TMPDIR` (plugin_runner_support/mod.rs:42-53), whose objects `cargo llvm-cov` never reports.

## Why it matters

Coverage can drop to near zero in the newest and most security-sensitive Rust crate without tripping the ratchet. The forcing function TBE-007 added therefore does not reach the code that confines third-party native plugins.

## Recommendation

Add `plugin-runner` (and optionally `plugin-api`) as gated components in coverage-ratchet.mjs and seed their baselines with `--update-baseline`. To make the number meaningful, either pass the runner binary built by plugin_runner_support to llvm-cov as an extra `--object`, or build it into the instrumented target dir via `TERMIHUB_PLUGIN_RUNNER=$(cargo llvm-cov ... --bin termihub-plugin-runner)`. Add unit tests for `Server::teardown` ordering and the `prepare_plugin_library`/`load` error paths.

## Verification

Confirmed: DIR_TO_COMPONENT (coverage-ratchet.mjs:42-48) maps only src/core/agent/src-tauri. plugin-runner and plugin-api fall to null (unified only), and coverage-baseline.json has no plugin-runner entry. plugin_runner_support builds the runner into a private CARGO_TARGET_TMPDIR (mod.rs:42-53), so process-level tests contribute no instrumented coverage. runner/mod.rs, shim.rs and loader/mod.rs have no test modules.
