---
id: DUP-013
title: Backend registry-registration lists are copy-pasted between desktop and agent
angle: code-duplication
severity: low
category: arch
is_workaround: false
subsystem: src-tauri/session/registry.rs vs agent/registry.rs
evidence:
  - src-tauri/src/session/registry.rs:14
  - agent/src/registry.rs:14
status: open
---

## What

`build_desktop_registry` and the agent's `build_registry` are copy-paste blocks of
`registry.register("local"/"serial"/"ssh"/"telnet"/"docker"/"wsl", …)` that differ only in the
desktop's extra graphical/FTP backends. The shared five/six-backend registration is written twice.

## Why it matters

Low, but it means the set of "core terminal backends" is defined in two lists that can drift (a new
core backend added to one and not the other). The backend implementations themselves are correctly
centralized in `core::backends`; only the registration list is duplicated.

## Evidence

- `src-tauri/src/session/registry.rs:14` — `build_desktop_registry`.
- `agent/src/registry.rs:14` — `build_registry`.

## Recommendation

Add `core::backends::register_core_terminal_backends(&mut registry)` that registers the shared
local/serial/ssh/telnet/docker/wsl set once. Each crate calls it, then adds its own extras (desktop:
graphical/ftp). Collapses the duplicated block and keeps the core backend list single-sourced.
