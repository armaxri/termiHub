---
id: DUP-005
title: OUTPUT_CHANNEL_CAPACITY = 64 is redefined in eight backend modules
angle: code-duplication
severity: low
category: arch
is_workaround: false
subsystem: core/backends/* + src-tauri/terminal/backend.rs
evidence:
  - core/src/backends/local_shell.rs:29
  - core/src/backends/ssh/mod.rs:51
  - src-tauri/src/terminal/backend.rs:281
status: open
---

## What

`const OUTPUT_CHANNEL_CAPACITY: usize = 64;` is copy-defined in eight places: every core backend
(`local_shell`, `serial`, `telnet`, `wsl`, `docker`, `ssh`, `plugin/connection`) plus
`src-tauri/src/terminal/backend.rs` (where it is `pub`). They all size the same thing — the
per-session output mpsc channel between the backend and its reader.

## Why it matters

Low blast radius, but it is textbook uncentralized-constant duplication: a change to the output
backpressure policy has to be made in eight files, and nothing keeps them equal. It also signals
that the per-backend output-channel wiring itself is boilerplate that repeats across backends.

## Evidence

Eight definitions of the identical constant:
- `core/src/backends/local_shell.rs:29`, `core/src/backends/serial.rs:23`,
  `core/src/backends/telnet.rs:26`, `core/src/backends/wsl.rs:27`,
  `core/src/backends/docker/mod.rs:36`, `core/src/backends/ssh/mod.rs:51`,
  `core/src/plugin/connection.rs:51`
- `src-tauri/src/terminal/backend.rs:281` (`pub const OUTPUT_CHANNEL_CAPACITY: usize = 64;`)

## Recommendation

Define it once in a core home (e.g. `core::session` or `core::backends`) as
`pub const OUTPUT_CHANNEL_CAPACITY` and have every backend and the desktop `terminal::backend`
import it. Consider whether the surrounding output-channel setup can be a shared helper too.
