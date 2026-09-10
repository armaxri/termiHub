---
id: DOC-009
title: README says "Windows X11 not currently supported" while code ships a Windows VcXsrv provisioning path and the licensing docs describe Windows X11 forwarding
angle: docs-accuracy
severity: medium
category: docs
is_workaround: false
subsystem: README/x11
evidence:
  - README.md:310
  - src-tauri/src/terminal/xserver/windows.rs:1
  - core/src/backends/ssh/x11.rs:24
  - docs/licensing.md:62
status: open
---

## What

The README's X11 Forwarding section states, for Windows, "**Not currently supported (relies on Unix
domain sockets)**". But the codebase ships a whole Windows X-server provisioning module
(`src-tauri/src/terminal/xserver/windows.rs`, detect + winget-install VcXsrv, #1318), the licensing
docs and `THIRD_PARTY_LICENSES.md` describe Windows VcXsrv usage "for SSH X11 forwarding", and the
`x-server-provisioning` concept is filed under `docs/concepts/implemented/`. The docs disagree with
each other about whether Windows X11 forwarding is a feature.

## Why it matters

Either Windows X11 works (and the README wrongly tells users it doesn't, hiding a shipped feature),
or Windows X11 provisioning is half-built (a VcXsrv installer exists but the SSH X11 channel is
`#[cfg(unix)]`-only, so the README is right and the licensing/concept docs over-claim). Both cases
are release-relevant doc defects, and the audit should surface the contradiction for the product
owner to resolve — the licensing doc's GPL analysis is even predicated on the Windows X11 use it
describes.

## Evidence

- README.md:310 — "**Windows** — Not currently supported (relies on Unix domain sockets)".
- `src-tauri/src/terminal/xserver/windows.rs:1` — "Windows VcXsrv detection and guided, consent-based
  install via winget (#1318) … to provide a local X server for SSH X11 forwarding".
- Countervailing code that supports the README: the SSH X11 forwarding channel logic in
  `core/src/backends/ssh/x11.rs` is gated `#[cfg(unix)]` throughout (lines 24, 345, 398, 489, 500,
  642, 659, …), i.e. the actual forwarding path does not compile on Windows.
- `docs/licensing.md:62` / `THIRD_PARTY_LICENSES.md:34-40` describe Windows VcXsrv "for SSH X11
  forwarding"; the concept is under `docs/concepts/implemented/x-server-provisioning.html`.

## Recommendation

Resolve the contradiction one way: if Windows X11 forwarding is not wired end-to-end, keep the
README statement but correct the licensing/`THIRD_PARTY_LICENSES`/concept text to not imply a
working Windows X11 forwarding feature (and consider why a Windows VcXsrv installer ships for an
unsupported path). If it does work, fix the README to document it. This finding is about the docs
disagreeing; product-completeness owns the underlying feature state.
