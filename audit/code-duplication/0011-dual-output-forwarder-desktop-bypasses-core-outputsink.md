---
id: DUP-011
title: Output-forwarder loop duplicated; desktop defines a parallel EventEmitter instead of core OutputSink
angle: code-duplication
severity: high
category: arch
is_workaround: false
subsystem: src-tauri/session/manager.rs vs agent/session/manager.rs + core/session/traits.rs
evidence:
  - core/src/session/traits.rs:35
  - agent/src/session/manager.rs:1148
  - src-tauri/src/session/manager.rs:141
  - src-tauri/src/session/manager.rs:1804
status: open
---

## What

`core::session::traits::OutputSink` (`send_output`/`send_exit`/`send_error`) is documented as *the*
desktop-vs-agent seam for delivering session output. Only the **agent** honors it
(`JsonRpcOutputSink`). The **desktop** defines a near-twin trait `EventEmitter`
(`emit_output`/`emit_exit`, impl for `tauri::AppHandle`) and its own `run_output_reader` loop that
does the same recv → deliver → on-close-emit-exit shape as the agent's `spawn_output_forwarder`.

## Why it matters

Two independent implementations of "output channel closed ⇒ session exited" — a reconnect-critical
transition — plus a parallel trait that shadows the core one the module docstring says exists for
exactly this purpose. The core seam is not pulling its weight; the desktop re-derived it.

## Evidence

- `core/src/session/traits.rs:35` — `OutputSink` trait (docstring claims it unifies desktop/agent).
- Agent: `agent/src/session/manager.rs:1148` `spawn_output_forwarder` → `JsonRpcOutputSink`
  (`agent/src/transport.rs:33`).
- Desktop: `src-tauri/src/session/manager.rs:141` `trait EventEmitter` (impl for `AppHandle` :180);
  `run_output_reader` :1804 does the recv→emit→exit loop with inline coalescing/capture/logging.

## Recommendation

Implement core `OutputSink` for the desktop emitter (delete the parallel `EventEmitter`), and lift
the recv → forward → settle loop into a shared `core` reader helper that takes an `OutputSink`. The
coalescing / screen-clear / logging pieces already live in `core::output` and can be composed in.
Enables DUP-010 (shared `SessionRegistry`).
