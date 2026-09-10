---
id: PROD-009
title: SFTP transfer Pause/Resume/Retry buttons are non-functional
angle: product-completeness
severity: high
category: bug
is_workaround: true
subsystem: src-tauri/src/files/transfer, src/components/TransferQueue
evidence:
  - src-tauri/src/commands/session.rs:547
  - src-tauri/src/files/transfer/mod.rs:244
  - src-tauri/src/files/transfer/registry.rs:549
  - src/components/TransferQueue/TransferControls.tsx:46
status: open
---

## What
SFTP transfers render Pause/Resume/Retry controls, but the SFTP copy path only honors
cancellation — it never reads the pause flag. The pause/resume/retry logic lives on a
separate "rich" transfer queue that SFTP does not use, so for SFTP these controls do nothing.

## Why it matters
Dead controls that appear functional are worse than absent ones: a user pausing a large
SFTP upload believes it paused when it keeps running (or the button is simply inert). This
is a shipped stopgap that will confuse and erode trust.

## Evidence
- `src-tauri/src/commands/session.rs:547-554, 606-613` — SFTP uses the legacy `registry.register` returning only a `CancellationToken`.
- `src-tauri/src/files/transfer/mod.rs:244-270` — `copy_chunked` checks `token.is_cancelled()` only; no `take_pause_request()`.
- `src-tauri/src/files/transfer/registry.rs:549-571` — pause/resume set a flag no SFTP executor reads.
- `src/components/TransferQueue/TransferControls.tsx:46-72` — Pause/Resume rendered for active/paused.

## Recommendation
Route SFTP transfers through the same rich queue/executor as FTP so pause/resume/retry are
honored, or hide the controls for transfers whose executor cannot pause. Prefer the former —
the machinery already exists.
