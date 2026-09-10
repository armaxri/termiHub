---
id: TBE-001
title: SSH exec ExitSignal path is untested and a unit test entrenches the "signal = exit 0" bug
angle: test-backend
severity: critical
category: test-gap
is_workaround: false
subsystem: core/backends/ssh/exec
evidence:
  - core/src/backends/ssh/exec.rs:143
  - core/src/backends/ssh/exec.rs:149
  - core/src/backends/ssh/exec.rs:85
  - core/src/backends/ssh/exec.rs:333
status: open
---

## What
`next_event()` handles `ChannelMsg::ExitStatus` but silently drops `ChannelMsg::ExitSignal`
(the catch-all `_ => {}` at exec.rs:149). A command killed by a signal (SIGKILL/SIGTERM/SIGSEGV)
therefore never sets `exit_status`, which defaults to `0` (exec.rs:85) — i.e. a signal-killed
remote command is reported as **success**. There is no test that feeds an `ExitSignal` down this
path, and worse, the unit test `defaults_exit_status_to_zero_when_unreported` (exec.rs:333)
**asserts** the default-to-0 behaviour, so the gap is codified as intended behaviour.

## Why it matters
On a safety-critical release, "the remote command succeeded" is a load-bearing signal
(`exec_probe`, agent deployment, monitoring probes at exec.rs:190 key off `exit_status == 0`).
Misclassifying a signalled death as exit 0 means a killed/crashed remote helper reads as healthy —
a silent-failure class the test suite is structurally blind to. The test mock channel can only
produce `ExitStatus` (exec.rs:143), never `ExitSignal`, so no existing test *could* catch it.

## Evidence
- exec.rs:143-149 — `ExitStatus` handled; `ExitSignal` hits `_ => {}` and is discarded.
- exec.rs:85 — `let mut exit_status = 0;` default when nothing sets it.
- exec.rs:333-339 — `defaults_exit_status_to_zero_when_unreported` asserts `exit_status == 0`
  for the "no exit reported" case, treating the buggy default as correct.
- `grep -rn ExitSignal core/ src-tauri/ agent/` → **no matches** anywhere.

## Recommendation
Add a unit test whose mock channel emits `ChannelMsg::ExitSignal { signal_name, ... }` and assert
the resulting `SshExecOutput` reflects a non-success (e.g. `128 + signum`, or a distinct
`terminated_by_signal` flag). Then fix `next_event()` to map `ExitSignal` to a failing status.
The regression test must exist *before* the fix (repo TDD rule). Re-evaluate
`defaults_exit_status_to_zero_when_unreported` — "no status at all" and "killed by signal" must
not both collapse to 0/success.
