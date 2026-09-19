---
id: TAURI-009
title: God-setup() (~920 lines) and several 2.5k–5.5k-line modules exceed the repo's size guideline
angle: backend-tauri-rust
severity: low
category: arch
is_workaround: false
subsystem: lib.rs / terminal / session / spawn / tunnel
evidence:
  - src-tauri/src/lib.rs:403
  - src-tauri/src/terminal/agent_manager.rs:1
  - src-tauri/src/session/manager.rs:1
  - src-tauri/src/spawn/registry.rs:1
  - src-tauri/src/tunnel/tunnel_manager.rs:1
status: open
---

## What

`setup()` (`lib.rs:403-1321`, ~920 lines) does everything inline: macOS defaults, log-layer
injection, portable-mode detection, config-dir resolution, plugin host/manager, ~11 domain
manager inits (each with a near-identical `match … { Ok => manage, Err => push RecoveryWarning }`
block), the entire projection wiring + 8 region seedings, the reconnect timer driver, the CLI
`--list-workspaces` handler, the spawn IPC server, and the connections-file poller. The single
`invoke_handler!` macro then lists ~270 commands.

Several modules are also far past the repo's own ~500-line-per-file guideline:

- `terminal/agent_manager.rs` — 5487
- `session/manager.rs` — 4916
- `spawn/registry.rs` — 2836
- `tunnel/tunnel_manager.rs` — 2654
- `connection/manager.rs` — 2470
- `session/remote_proxy.rs` — 1915

## Why it matters

`setup()` is also the file the coordinator's own notes flag as a merge-conflict hotspot ("every
projection domain registers its region in one `setup()` block → shadow-vs-shadow conflicts").
A 900-line function with 15 responsibilities is hard to review line-by-line (the bar for this
release), easy to introduce ordering bugs in (managed-state dependencies are implicit and
order-sensitive — e.g. the projection block must run after the tunnel/session/connection
managers are managed), and a serialization point for parallel work. The 5k-line managers are
individually hard to reason about for lifecycle/lock correctness (see TAURI-004, concentrated in
exactly these files).

## Evidence

- `lib.rs:403-1321` — the `setup` closure.
- `wc -l` top offenders as listed above; the repo guideline (~500 lines) is referenced in the
  coordinator/contributing docs.

## Recommendation

Extract `setup()` into ordered, named phases — `init_storage(app)`, `init_managers(app)`,
`init_projection(app)`, `init_ipc_and_watchers(app)` — each returning collected
`RecoveryWarning`s, and give each domain a `fn register(app) -> Result<…>` so its region
registration/seeding lives with the domain, not in `lib.rs`. This directly reduces the
`setup()` conflict surface. For the 2.5k–5.5k-line managers, split along the seams already
implied by their impl blocks (e.g. agent-manager: connection lifecycle / RPC client / forwarding
/ reconnect). Defer to the code-duplication expert for the cross-file boilerplate portion.
</content>
