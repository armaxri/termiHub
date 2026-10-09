---
id: WA-RS2-001
title: "A connection's initialCommand hides all terminal output for up to 5 s on macOS/Linux (a stale wait-for-clear workaround)"
angle: workaround-rust
severity: medium
category: stale-workaround
is_workaround: true
subsystem: src-tauri/session/manager + core/session/pump
evidence:
  - src-tauri/src/session/manager.rs:1312
  - src-tauri/src/session/manager.rs:1347
  - src-tauri/src/session/manager.rs:53
  - src-tauri/src/session/manager.rs:1366
  - src-tauri/src/session/manager.rs:1368
  - src-tauri/src/session/manager.rs:1459
  - core/src/session/pump.rs:107
  - core/src/session/shell.rs:1392
  - core/src/session/shell.rs:500
  - src/utils/openLocalCommandTab.ts:20
status: fixed
resolution: "#4345 — removed the buffer-until-clear phase; the initial command now waits for the OSC 133 prompt mark (1 s fallback) and logs failed sends"
audit: 2026-10
commit: 663465d52
relation: new
---

## What

When a connection has a non-empty `initialCommand` setting, `create_session` sets
`has_initial_command` and passes it as `wait_for_clear` to `run_output_reader`
(manager.rs:1312-1347). The pump then buffers all output until it sees a full
screen clear (`CSI 2J/3J` or `ESC c`) or `CLEAR_WAIT_TIMEOUT` (5 s) runs out
(pump.rs:107-150).

This came from commit 6c5915917, when the internal OSC 7 setup command emitted
`printf '\033[2J\033[H'`. Commit ab23d4660 replaced that full clear with targeted
line erases, and a test now asserts the setup must NOT contain `\033[2J`
(shell.rs:1392). Nothing emits a clear any more.

A user `initialCommand` (workspace tabs, openLocalCommandTab, `make release`) is
just written as `cmd\n` after a blind 200 ms timer (manager.rs:1366-1369). On Unix
shells the pump therefore always waits the full 5 s before showing anything.
Windows ConPTY happens to emit its own 2J at startup, so the bug is
platform-dependent. Any failure of the injected write is also discarded
(`let _ =`, manager.rs:1459). The core helper `initial_command_strategy` that
models this (shell.rs:493-500) is only called from tests.

## Why it matters

On macOS and Linux, every local, WSL or workspace tab opened with an initial
command shows a blank terminal for about 5 s. Then the whole prompt, the echoed
command and its first 5 s of output appear at once. Keystrokes typed during that
window echo invisibly. Behaviour differs between Windows and Unix for no stated
reason, and a lost injection leaves no trace in the log.

## Recommendation

Stop deriving `wait_for_clear` from `initialCommand`: pass `false` (or remove
buffer-until-clear entirely if nothing else needs it). If the original goal of no
visible flash still matters, gate it on something that actually emits a clear.
Replace the blind 200 ms injection with a readiness signal where one exists (the
OSC 133 prompt marker from shell integration), keeping a timeout as fallback. Log
a failed injection with `warn!` instead of `let _ =`. Delete or wire up the unused
`initial_command_strategy`/`InitialCommandStrategy`. Add a regression test that a
session with `initialCommand` and no clear sequence flushes output promptly.

## Verification

Confirmed. manager.rs:1312-1347 derives `has_initial_command` from
settings.initialCommand and passes it as `wait_for_clear` into run*output_pump.
Phase 1 (pump.rs:107-150) buffers until ScreenClearDetector sees CSI 2J/3J or
ESC c, or until CLEAR_WAIT_TIMEOUT (5 s) expires. On Unix nothing in production
emits a full clear: bash_osc7_command/wsl_osc7_command (shell.rs:592-610) only
echo a notice and register the prompt hook, and tests at 1392/1424 assert there
is no `\033[2J`. The only non-test 2J/cls sources are the PowerShell Clear-Host
and cmd cls setups, so the behaviour differs by platform. The injection is a
blind 200 ms timer, and `let * = send_input_normalized` at manager.rs:1459
discards errors. initial_command_strategy is used only in tests. No ADR or audit
entry justifies the 5 s buffer. Medium fits: every initialCommand tab on
macOS/Linux, including SSH since create_session is generic, stays blank for 5 s.
