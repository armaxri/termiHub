---
id: TBE2-006
title: "The headless agent-reconnect tests skip silently without sshd or the agent binary, and no lane requires them to run"
angle: test-backend
severity: low
category: test-gap
is_workaround: false
subsystem: src-tauri/terminal/agent_manager reconnect tests
evidence:
  - src-tauri/src/terminal/agent_manager/russh_reconnect_tests.rs:28
  - src-tauri/src/terminal/agent_manager/russh_reconnect_tests.rs:36
  - src-tauri/src/terminal/agent_manager/russh_reconnect_tests.rs:52
  - src-tauri/src/terminal/agent_manager/russh_reconnect_tests.rs:1144
  - src-tauri/src/terminal/agent_manager/russh_reconnect_tests.rs:1145
  - src-tauri/src/terminal/agent_manager/russh_reconnect_tests.rs:2506
  - scripts/internal/ci-rust-tests.sh:63
  - core/tests/common/mod.rs:150
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: new
---

## What

russh_reconnect_tests.rs holds the 'definitive last-layer' headless tests for agent reconnect (the #2476/#2491 regression guard, RECONNECT_SETTLE_CEILING). It has 17 `SKIP:` early returns that pass green when `find_sshd()` finds no /usr/sbin/sshd, /sbin/sshd or PATH sshd, or when `find_agent_binary()` finds no prebuilt termihub-agent next to the test binary. A narrower invocation such as `cargo test -p termihub --lib` does not build that binary. Unlike the native-sshd suites, which honour TERMIHUB_NATIVE_SSHD (core/tests/common/mod.rs:150) and run under run-native-sshd-suites.sh, there is no env knob that turns a missing sshd or agent binary into a failure. CI runs them only in the `heavy` phase on whatever sshd the hosted runner image happens to ship, and nothing asserts they actually executed.

## Why it matters

The reconnect path is the safety-critical piece the project chose to verify headlessly instead of live. If a runner image drops sshd, or the build graph stops producing the agent binary before these tests run, the regression guard turns into a silent no-op and nobody notices.

## Recommendation

Add a TERMIHUB_REQUIRE_LOCAL_SSHD (or reuse TERMIHUB_NATIVE_SSHD) check: when set, a missing sshd or agent binary panics. Set it on the Linux and macOS 'Run Rust tests (contention-sensitive suites)' steps, and install openssh-server explicitly on ubuntu so the precondition is guaranteed. Alternatively, have the `heavy` phase check that the expected number of `russh_reconnect_tests::` tests ran and that their output contains no `SKIP:`.

## Verification

Confirmed: find_sshd()/find_agent_binary() return None and the file has 17 `SKIP:` early returns, with no env knob that makes absence fatal (no REQUIRE/NATIVE_SSHD reference). ci-rust-tests.sh lists the module in HEAVY_FILTERS but only prints a per-filter test count; it does not check for SKIP output. No workflow installs openssh-server for this step, so it relies on the runner image. In practice `--workspace` builds the agent binary and macOS ships /usr/sbin/sshd, so the risk is latent: low.
