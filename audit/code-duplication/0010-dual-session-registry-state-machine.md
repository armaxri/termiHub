---
id: DUP-010
title: The session lifecycle/registry state machine is implemented twice (desktop and agent)
angle: code-duplication
severity: high
category: arch
is_workaround: false
subsystem: src-tauri/session/manager.rs vs agent/session/manager.rs
evidence:
  - src-tauri/src/session/manager.rs:387
  - agent/src/session/manager.rs:344
  - agent/src/session/manager.rs:1197
  - core/src/session/mod.rs
status: open
---

## What

The desktop and the agent each hand-roll the same session-tracking state machine over a
`HashMap<session_id, …>`. Both independently implement: create-with-limit + uuid + snapshot,
close / close-all, attach / detach (with an `attached` flag), and "settle a session to `Exited`
when its backend dies on its own." There is **no `SessionManager`/`SessionRegistry` in core** —
`core/src/session/mod.rs` holds only the per-type command builders (`docker`/`serial`/`shell`/`ssh`/
`traits`).

## Why it matters

The "natural-exit ⇒ settle to Exited" and attach/detach transitions are reconnect-critical, safety-
relevant logic (the agent's `settle_exited` is the #2369 fix). Having them in two places means a fix
to one must be mirrored by hand into the other, and the two have already diverged (the desktop
manager also carries monitoring tasks, tab-id bridges, retained-requests and remote-proxy
delegation; the agent carries the daemon/in-process split and deferred-update hooks). This is the
clearest "core should own this" gap in the session layer.

## Evidence

- Desktop: `src-tauri/src/session/manager.rs:387` `SessionManager` → `sessions: HashMap`
  (`SessionEntry` :266, `SessionInfo` :229); `close_session` :1110; attach/detach :1557/:1679;
  `run_output_reader` :1804.
- Agent: `agent/src/session/manager.rs:344` `SessionManager` → `sessions: HashMap`
  (`SessionInfo`/`SessionBackend` in `agent/src/session/types.rs:34-97`); `create` :478; `close`
  :715; `attach`/`detach` :822/:841; `detach_all` :798; `settle_exited` :1197.
- No core equivalent (`core/src/session/mod.rs`).

## Recommendation

Introduce a generic `core::session::SessionRegistry<B>` owning the id-map + lifecycle transitions
(create / close / attach / detach / settle-exited / snapshot), parameterized over a backend kind and
a `core::session::traits::OutputSink` (see DUP-011/DUP-012). Each crate keeps only its
backend-construction and transport wiring. Highest-payoff consolidation in this audit alongside
DUP-011.
