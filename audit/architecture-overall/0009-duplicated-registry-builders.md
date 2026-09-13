---
id: ARCH-009
title: Desktop and agent duplicate the core-backend registration block instead of sharing a core-provided default set
angle: architecture-overall
severity: low
category: arch
is_workaround: false
subsystem: src-tauri/src/session/registry.rs, agent/src/registry.rs
evidence:
  - src-tauri/src/session/registry.rs:14
  - agent/src/registry.rs:14
status: open
---

## What

The whole point of ADR-7 is that desktop and agent are "thin transport adapters
over core." They almost are — but the `ConnectionTypeRegistry` population is
copy-pasted between the two hosts. Both
`src-tauri/src/session/registry.rs` (`build_desktop_registry`) and
`agent/src/registry.rs` (`build_registry`) contain the same
`registry.register("local"/"serial"/"ssh"/"telnet"/"docker"/"wsl", …,
core::backends::X::new())` block for the shared subset; the desktop version then
adds the graphical/ftp types the agent omits.

This is thin wiring, not duplicated *logic* (all behavior lives in
`core/src/backends/`), so the blast radius is small — but it is the one visible
seam where the "shared core" claim leaks: the shared subset of registrations is
declared twice and can drift (a backend added to one host's list and not the
other).

## Why it matters

- Adding or renaming a built-in backend requires editing two lists; forgetting
  one silently makes a type available on desktop but not agent (or vice versa).
- It is the small, easily-fixed exception to an otherwise clean layering (see the
  summary — core has zero upward dependencies), worth closing so the abstraction
  is airtight.

## Evidence

- `src-tauri/src/session/registry.rs:14-119` — registers local/serial/ssh/
  telnet/docker/wsl (+ ftp, mock-remote-desktop, vnc, rdp).
- `agent/src/registry.rs:14-78` — registers the identical local/serial/ssh/
  telnet/docker/wsl subset.

## Recommendation

Add a `termihub_core`-provided helper (e.g.
`ConnectionTypeRegistry::with_core_backends()` or a `register_core_backends(&mut
registry)` gated by the same cargo features) that both hosts call, then each host
layers only its host-specific extras (desktop: ftp/graphical; agent: none). One
declaration of the shared set, feature-gated in core, removes the drift risk.
