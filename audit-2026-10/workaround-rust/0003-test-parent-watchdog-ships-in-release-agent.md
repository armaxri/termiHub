---
id: WA-RS2-003
title: "The test-only parent-death watchdog ships in the release agent and is armed by an env var"
angle: workaround-rust
severity: low
category: test-scaffolding-in-prod
is_workaround: true
subsystem: agent/test_parent_watchdog
evidence:
  - agent/src/main.rs:27
  - agent/src/main.rs:105
  - agent/src/main.rs:107
  - agent/src/test_parent_watchdog.rs:33
  - agent/src/test_parent_watchdog.rs:46
  - agent/src/test_parent_watchdog.rs:57
  - agent/src/test_parent_watchdog.rs:123
  - agent/src/io/tcp.rs:276
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: regression
previous_id: WA-RS-009
---

## What

`test_parent_watchdog` (#3641) exists only so integration-test harnesses can tear
down leaked agents. It is compiled into every agent build, and `main()` calls
`start_from_env()` unconditionally. If `TERMIHUB_TEST_PARENT_PID` names a
process, a thread watches it and calls `std::process::exit(1)` when it
disappears. That is a hard exit with no session or daemon cleanup. The variable
is inherited, so session and registry daemons arm themselves too. On Windows, a
null `OpenProcess` handle (no such PID, or an inaccessible one) exits immediately
(line 123-126). This breaks the policy set when WA-RS-009 was fixed: tcp.rs:276-281
documents that no env-var-triggered test scaffolding ships in the release agent.
The crate already has an off-by-default `test-hooks` feature for exactly this
class (agent/Cargo.toml:32-36).

## Why it matters

A release agent, including the daemons that keep sessions alive across
reconnects by design, can be made to exit abruptly by an inherited env var. A
stale value in a service environment, or PID reuse, would kill persistent remote
sessions with no clear diagnostic. It also widens the env-controlled surface of a
safety-critical binary, against an explicit prior remediation.

## Recommendation

Gate the module and its call in `main()` behind
`#[cfg(any(debug_assertions, feature = "test-hooks"))]`, the same pattern as the
`startup_test_delay` fix. Make the release path a no-op stub, and enable
`test-hooks` in the harness builds that spawn release-profile agents (the
src-tauri russh_reconnect_tests sshd-launched agent and
build-system-test-agent.sh). Add a check, like the one that verified #2847 via
`strings`, that a `--release` agent does not contain `TERMIHUB_TEST_PARENT_PID`.

## Verification

Confirmed. main.rs:27 declares `mod test_parent_watchdog` with no cfg gate, and
main() calls start_from_env() unconditionally (105-107). The module's own docs
call it test-only and harness-set. When the env var is set it calls
process::exit(1) with no cleanup. On Windows a null OpenProcess handle exits
immediately. This contradicts the WA-RS-009/AGT-008 precedent: startup_test_delay
is gated on `#[cfg(debug_assertions)]` (tcp.rs:276-281), and the update test hook
is gated on the test-hooks feature (Cargo.toml). Exploiting it needs control of
the agent's environment, and the variable is inert by default, so this is low
severity: a policy and hardening gap, not an active bug.
