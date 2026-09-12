---
id: MOCK-006
title: SSH exec MockChannel's event vocabulary is structurally narrower than a real ssh2 channel — signal-death exit is unrepresentable
angle: test-mocking
severity: medium
category: test-gap
is_workaround: false
subsystem: core/backends/ssh/exec
evidence:
  - core/src/backends/ssh/exec.rs:218
  - core/src/backends/ssh/exec.rs:270
status: open
---

## What
`run_exec()` is tested against a scripted `MockChannel` that yields a `VecDeque<ExecEvent>`
(`core/src/backends/ssh/exec.rs:218`). The `ExecEvent` vocabulary the mock can emit models
`Stdout`, `Stderr`, `Exit(code)`, `Eof`, `Closed` — an **exit *code*** only. A real remote
process can terminate by **signal** (SIGKILL/SIGTERM/OOM), which a real SSH channel surfaces
as an exit-signal message distinct from an exit-status; the mock has no event that represents
this, so no test using `MockChannel` can drive the signal-death path.

This is the mock-fidelity root cause behind TBE-001 (SSH exec treats signal-death as exit 0):
the double's contract is *narrower* than the thing it stands in for, so the buggy behavior is
not merely untested — it is **unreachable** by the existing test harness. Every `MockChannel`
test (`captures_stdout_stderr_and_exit_status`, `concatenates_multiple_stdout_chunks`, …)
therefore only ever proves the exit-code path.

## Why it matters
- A mock that cannot express a real termination mode gives false confidence that exit handling
  is covered. A caller relying on exec exit status to gate a privileged action (e.g. the
  `sudo`/exec-capability probe at `exec.rs:200`) would see a signal-killed command as
  success = exit 0.
- This is the "mock simpler/safer than reality" pattern in its purest form: the divergence is
  in the *type*, not just the *data*, so it silently narrows what the whole suite can test.

## Evidence
- Scripted mock and its event list: `core/src/backends/ssh/exec.rs:218-260`.
- Tests only ever push `ExecEvent::Exit(n)` (never a signal variant): `exec.rs:270-320`.

## Recommendation
Extend `ExecEvent` (and the real channel adapter) with an explicit `ExitSignal { name, core_dumped }`
variant, teach `run_exec` to map signal-death to a non-zero / distinguished result, and add a
`MockChannel` test that scripts `ExitSignal` and asserts the caller does **not** see success.
This closes both the fidelity gap (the mock can now model reality) and the TBE-001 bug in one
change, TDD-style (signal test red → fix green).
