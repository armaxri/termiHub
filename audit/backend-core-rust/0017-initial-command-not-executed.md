---
id: CORE-017
title: initialCommand may be parsed from config but never written to the shell
angle: backend-core-rust
severity: medium
category: bug
is_workaround: false
subsystem: core/backends/local_shell
evidence:
  - core/src/backends/local_shell.rs
status: fixed
resolution: "n/a — not-a-bug: initialCommand IS injected by src-tauri SessionManager (inject_initial_command, #792 test); core deliberately doesn't — audit missed the session-manager layer"
---

## What
A helper agent auditing the local-shell/session backends reported that the
`initialCommand` connection setting is read from config but no code path writes
it to the spawned PTY after connect (the shell starts but the configured startup
command is never sent).

## Why it matters
Users who configure an initial command (a documented connection field) get a
shell that silently ignores it — a missing-feature/bug on a user-facing setting.

## Evidence
`core/src/backends/local_shell.rs` (spawn/connect path) — no `write_input` of the
configured initial command after the reader/writer are wired. Confirm against the
schema field and the other backends (SSH/WSL/serial) for consistent handling.

## Recommendation
After the session is connected, write the resolved `initialCommand` (plus a
trailing newline) to the PTY input, once, guarded so it is not resent on
reconnect unless intended. Add a test asserting the bytes reach the writer.
