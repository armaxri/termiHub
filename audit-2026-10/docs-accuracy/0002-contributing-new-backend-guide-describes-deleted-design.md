---
id: DOC2-002
title: "contributing.md 'Adding a New Terminal Backend' guide describes the deleted TerminalBackend/TerminalManager design"
angle: docs-accuracy
severity: medium
category: stale-guide
is_workaround: false
subsystem: "docs/contributing.md"
status: open
resolution: ""
audit: "2026-10"
commit: "663465d52"
relation: new
evidence:
  - docs/contributing.md:735-772
  - docs/contributing.md:1854-1855
  - src-tauri/src/terminal/backend.rs:3-5
  - core/src/connection/mod.rs:180
  - docs/architecture.md:563-572
---

## What

The contributor guide (contributing.md:735-772) tells authors to implement the `TerminalBackend` trait in `src-tauri/src/terminal/` and register it in `src-tauri/src/terminal/manager.rs`. It also says to add a config struct and TS types, write a per-type settings component in `src/components/Settings/`, and edit the dropdown in `src/components/Sidebar/ConnectionEditor.tsx`. None of this matches the code. manager.rs and Sidebar/ConnectionEditor.tsx do not exist, and backend.rs:3-5 says the TerminalBackend trait was replaced by core's `ConnectionType` trait. The real procedure, documented correctly at architecture.md:563-572, is: implement `ConnectionType` in core/src/backends/, add a cargo feature, register the factory, and the frontend picks it up through the schema with no frontend changes. The performance section is stale the same way: it puts output coalescing in `src-tauri/src/terminal/manager.rs` (actually core/src/output/coalescer.rs via core/src/session/pump.rs) and claims `sync_channel(64)` in terminal/backend.rs.

## Why it matters

A contributor following the guide will build the wrong architecture: hardcoded forms and a removed trait. That directly contradicts ADR-7/ADR-8.

## Recommendation

Replace the section with the four steps from architecture.md §5 (ConnectionType in core/src/backends/<name>, cargo feature in core/Cargo.toml, factory registration in desktop and agent startup, settings schema with no frontend change), or link to that section. Fix the Location: entries in the performance section to core/src/output/coalescer.rs and core/src/session/pump.rs.

## Verification

Confirmed. contributing.md tells contributors to implement the TerminalBackend trait and register it in terminal/manager.rs, and to edit Sidebar/ConnectionEditor.tsx. manager.rs and ConnectionEditor.tsx do not exist, and backend.rs:3-5 says the trait was replaced by core's ConnectionType.
