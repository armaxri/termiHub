---
id: DOC2-005
title: "architecture.md building-block view lists agent and desktop modules that no longer exist, and other stale structural claims"
angle: docs-accuracy
severity: low
category: stale-reference
is_workaround: false
subsystem: "docs/architecture.md"
status: open
resolution: ""
audit: "2026-10"
commit: "663465d52"
relation: new
evidence:
  - docs/architecture.md:354
  - docs/architecture.md:452-457
  - docs/architecture.md:329
  - docs/architecture.md:2475
  - docs/architecture.md:2984
  - docs/architecture.md:1186-1193
  - docs/architecture.md:144
  - core/src/buffer/mod.rs:16
  - core/src/embedded_servers/ftp_server.rs
  - core/src/backends/ftp/transfer.rs
  - .github/workflows/code-quality.yml
---

## What

Several structural claims in architecture.md are out of date. (1) The Level-2 agent table (lines 452-457) lists agent/src/buffer, shell, docker, ssh and serial, none of which exist; the ring buffer is core/src/buffer and the backends are core/src/backends. (2) The desktop table lists src-tauri/src/monitoring/ (line 354), which does not exist, and leaves out the projection-region modules (session_projection, connections_projection, etc.) that ADR-14 makes the source of UI state. Line 329 still calls appStore.ts the store "managing all frontend state". (3) Line 2475 places the embedded FTP server at src-tauri/src/embedded_servers/ftp_server.rs; it is core/src/embedded_servers/ftp_server.rs. Line 2984 cites src-tauri/src/files/transfer/ftp.rs, which does not exist (FTP transfers are in core/src/backends/ftp/transfer.rs). (4) The CI/CD table (1186-1193) says "Three" workflows, lists four, and gives the trigger as push/PR to main only. code-quality, build and agent also trigger on develop, and there are about 28 workflows. (5) The context table (line 144) lists X servers for macOS and Linux only and leaves out Windows/VcXsrv.

## Why it matters

These are the module map and CI overview a new contributor or auditor reads first. Five nonexistent paths and a description of appStore that contradicts ADR-14 point readers to the wrong code.

## Recommendation

Regenerate the Level-2 tables from the actual src-tauri/src and agent/src directories: drop the moved agent rows, add the projection modules, and describe appStore as the UI-local and mirror layer per ADR-14. Fix the FTP server and transfer paths. Replace the CI table with a pointer to contributing.md's CI section, or list the current PR, post-merge and nightly lanes with their develop/main triggers. Add Windows (VcXsrv via winget) to line 144.

## Verification

Confirmed. agent/src has no buffer, shell, docker, ssh or serial directories. src-tauri/src/monitoring does not exist. Line 2475 places the FTP server under src-tauri, while line 2621 of the same doc correctly says core. src-tauri/src/files/transfer/ftp.rs does not exist; the code is core/src/backends/ftp/transfer.rs. The CI table says 'Three', lists four rows, gives main-only triggers, and there are 28 workflow files.
