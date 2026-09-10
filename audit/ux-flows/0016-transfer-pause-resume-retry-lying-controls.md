---
id: UX-016
title: Transfer Pause/Resume/Retry are no-ops for SSH/SFTP yet always toast success
angle: ux-flows
severity: high
category: bug
is_workaround: true
subsystem: src/components/TransferQueue
evidence:
  - src/components/TransferQueue/TransferQueue.tsx:45
  - src-tauri/src/files/transfer/registry.rs:587
  - src-tauri/src/commands/session.rs:547
status: open
---

## What
The Transfer Queue's Pause/Resume/Retry controls are fully wired in the frontend, call real Tauri
commands, and then **unconditionally toast success** — but the backend silently no-ops them for the
common (SSH/SFTP) transfer path, producing **false success feedback**. This is worse than a dead
control: it is a lying control.

Trace:
- `TransferQueue.tsx:45-60` — handlers call `transferPause/Resume/Retry`, then unconditionally
  `toast.success("Transfer paused" / "resumed" / "Retrying transfer")`.
- `src-tauri/src/files/transfer/registry.rs:551-589` — `pause()/resume()/retry()` resolve the id via
  `get()`, which looks up **only** `self.lock().rich.get(id)`. Unknown id → returns `false` (silent
  no-op).
- `src-tauri/src/commands/session.rs:547,606` — SSH/SFTP download/upload register via
  `registry.register(...)`, which inserts into the **`legacy`** map (`registry.rs:332`), never
  `rich`. Only FTP (feature-gated, off by default) uses `rich`.

Consequences:
- Click **Pause** on an SSH transfer → green "Transfer paused" toast, transfer keeps running at full
  speed.
- **Resume** never even renders for SSH/SFTP: since Pause never transitions the row to `paused`
  (`TransferControls.tsx:60`), the state guard never becomes true.
- **Retry** on a failed SFTP transfer is the same false-success no-op.
- **Cancel** is the one honest control — `registry.cancel()` explicitly checks `legacy` first
  (`registry.rs:352-354`).

## Why it matters
Users are shown a confirmed success for an operation that did nothing, on the primary file-transfer
path. This destroys trust in the transfer UI (a user who "pauses" to relieve a slow link is misled)
and is a shippable-blocker-grade correctness/UX defect. Corroborates the product-completeness
finding PROD-009 and adds the false-toast dimension.

## Evidence
- `TransferQueue.tsx:45-60` — unconditional success toasts.
- `registry.rs:551-589` — pause/resume/retry only touch `rich`.
- `session.rs:547,606` + `registry.rs:332` — SSH/SFTP transfers live in `legacy`.

## Recommendation
Either implement pause/resume/retry for `legacy` (SSH/SFTP) transfers in the registry, or — until
that lands — hide the Pause/Resume/Retry controls for transfers that do not support them and never
toast success on a backend no-op (thread the command's boolean result back to the UI and only toast
on a real state change). Do not ship success feedback for operations that did nothing.
