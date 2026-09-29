---
id: CORE-032
title: Plugin package extraction reads entries unbounded and can follow symlink/recursive entries
angle: backend-core-rust
severity: high
category: security
is_workaround: false
subsystem: core/plugin
evidence:
  - core/src/plugin/pack.rs
  - core/src/plugin/package.rs
status: fixed
resolution: "#2787 — entry-count cap 8192 + symlink-entry rejection (size caps + traversal guard already present)"
---

## What
The `.termihub-plugin` (ZIP) reader reads entry contents into memory without a
size ceiling and does not defend against symlink entries / recursive extraction
(reported by the plugin/files audit). Path traversal (`..`/absolute) is handled
elsewhere (`manager.rs`), but decompression-bomb size and symlink entries are not.

## Why it matters
A plugin package is attacker-supplied content that a user may install. Without a
per-entry and total-size cap, a zip bomb OOMs the host during install; a symlink
entry extracted to disk can point outside the plugin directory and be followed by
later steps (or by the plugin at runtime), escaping the plugin sandbox even
though the archive path itself looked contained.

## Evidence
`core/src/plugin/pack.rs` / `core/src/plugin/package.rs` — entry read loops with
no `max` on uncompressed size and no symlink-entry rejection.

## Recommendation
Enforce a per-entry and total uncompressed-size limit (reject when exceeded),
cap the entry count, and reject symlink entries (or refuse to create them on
extraction). Reuse the existing traversal guard from `manager.rs` alongside these.
