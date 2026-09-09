---
id: ARCH-002
title: lib.rs setup() is a ~700-line god-function and the backend serialization point
angle: architecture-overall
severity: medium
category: arch
is_workaround: false
subsystem: src-tauri/src/lib.rs
evidence:
  - src-tauri/src/lib.rs:403
  - src-tauri/src/lib.rs:774
  - src-tauri/src/lib.rs:1322
status: open
---

## What

`src-tauri/src/lib.rs` (1789 lines) contains one `setup()` closure spanning
~lines 403–1300 that manually wires the entire backend: plugin host, credential
manager, connection manager, session managers (terminal + graphical), SSH/RDP
trust stores, X-server provisioner, tunnel/workspace/macro/session-history/
workflow/embedded-server managers, and the whole projection substrate. The
projection-registration block alone (lines 774–1098) is ~325 lines of
copy-shaped, per-domain imperative wiring: for each of the 11 regions it
`app.manage(Arc::new(SomeStore::new()))`, calls `register_*_intents(&mut
registry, …)`, then conditionally `register_region(…, store.snapshot())`.

The `invoke_handler![…]` list (lines 1322–1633) registers **~206 typed
commands** in one macro call.

This file is the documented backend serialization point (the coordinator's rule:
"`src-tauri/src/lib.rs` setup() block — every projection domain registers its
region in one block → shadow-vs-shadow conflicts").

## Why it matters

- **Coupling / merge serialization:** every new domain, backend, manager, or
  command edits this one function; two backend features collide here by
  construction. #2077 modularizing this registration is explicitly cited as what
  "would raise the ceiling."
- **Cohesion:** the function mixes concerns at every altitude — logging setup,
  portable-mode env mutation (`unsafe set_var`), macOS AppKit defaults, plugin
  loading, per-domain projection wiring, CLI flag handling.
- **Startup ordering is implicit:** the projection block *must* run after the
  tunnel manager is managed (commented at 768–773); the ordering constraints are
  encoded only in comments and code position, not in types.

## Evidence

- `src-tauri/src/lib.rs:403` — `.setup(move |app| { … })` opens the closure.
- `src-tauri/src/lib.rs:774-1098` — the projection registration block; 11
  near-identical `manage + register_*_intents + register_region` stanzas.
- `src-tauri/src/lib.rs:1322-1633` — one `generate_handler!` with ~206 commands.

## Recommendation

Extract per-subsystem init functions (`fn init_projection(app) -> …`,
`fn init_credentials(app) -> …`, etc.), each owning its own `manage`/register
calls and returning its recovery warnings, so `setup()` becomes a short ordered
list of calls. Give the projection registry a data-driven registration table
(iterate a `[(region, register_fn, seed_fn)]` slice) so adding a domain appends
one entry instead of a hand-written stanza. This directly removes the shadow-vs-
shadow conflict class the coordinator works around today.
