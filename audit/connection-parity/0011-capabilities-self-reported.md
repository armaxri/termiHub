---
id: PARITY-011
title: Capabilities are self-reported, not enforced; two parallel backend traits
angle: connection-parity
severity: info
category: arch
is_workaround: false
subsystem: core/src/connection
evidence:
  - core/src/connection/mod.rs:59
  - core/src/connection/mod.rs:115
  - core/src/connection/graphical.rs:580
status: open
---

## What

Parity is enforced by convention, not by types. The `Capabilities` struct
(`monitoring/file_browser/graphical/resize/persistent/terminal`) is a plain bag of booleans that
each backend fills in by hand, and the `ConnectionType` trait requires every backend to implement
`write`, `resize`, and `subscribe_output` regardless of whether they mean anything. Non-terminal
backends satisfy the trait with no-ops / closed channels:

- FTP `write`/`resize` return `Ok(())` and `subscribe_output` hands back an immediately-closed
  receiver.
- Graphical backends (VNC/RDP/mock) are terminal-less but still implement the terminal methods as
  inert stubs, and expose their *real* surface through a **second** trait, `GraphicalBackend`,
  reached via `ConnectionType::graphical()`.

So there are two capability traits (`ConnectionType`, `GraphicalBackend`) and a boolean struct that
must be kept manually consistent with which trait methods actually do something.

## Why it matters

- Nothing prevents a backend from reporting `resize: true` while `resize()` is a no-op, or
  `file_browser: true` while `file_browser()` returns `None` when disconnected — the flags and the
  behaviour can drift, and the only guard is per-backend unit tests.
- New backends must remember to implement inert stubs for methods that don't apply, which is
  boilerplate and an easy place to introduce an inconsistency (e.g. a `subscribe_output` that never
  closes, hanging a reader).
- This is the root cause behind several other findings (PARITY-001 tunnels-as-string,
  PARITY-002 monitoring-flag-honoured-by-one-backend): the capability model is advisory, so
  capabilities are added/checked ad hoc rather than through one enforced contract.

## Evidence

- `core/src/connection/mod.rs:59` — `Capabilities` struct of self-reported booleans.
- `core/src/connection/mod.rs:115` — `ConnectionType` requires `write`/`resize`/`subscribe_output`
  of all backends; FTP (`core/src/backends/ftp/mod.rs:559`) implements them as no-ops.
- `core/src/connection/graphical.rs:580` — the parallel `GraphicalBackend` trait.

## Recommendation

Longer-term, consider splitting the terminal I/O methods into a capability trait a backend returns
(like `file_browser()` / `graphical()` already do) so a backend only implements the surfaces it
actually has, and the `Capabilities` flags are derived from which sub-traits are present rather than
hand-declared. This is an architecture observation, not a defect — noted so the parity gaps above
are understood as symptoms of an advisory capability model, not isolated bugs.
