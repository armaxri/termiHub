---
id: WA-FE2-009
title: "useTransferReconcile 4s polling backstop is justified by dropped webview events, which no longer applies now that progress is folded on the server"
angle: workaround-frontend
severity: info
category: workaround
is_workaround: true
subsystem: "hooks/useTransferReconcile (transfers region)"
evidence:
  - src/hooks/useTransferReconcile.ts:15
  - src/hooks/useTransferReconcile.ts:20
  - src/hooks/useTransferReconcile.ts:23
  - src/hooks/useTransferReconcile.ts:60
  - src/store/transfersBridge.ts:229
  - src/store/transfersBridge.ts:234
  - src-tauri/src/files/transfer/mod.rs:112
  - src-tauri/src/files/transfer/relaunch.rs:968
status: fixed
resolution: "#4387 — audited every termination path; gated late seeds on a live handle; poll and reconcile route retired"
audit: 2026-10
commit: 663465d52
relation: new
---

## What

While any transfer row is non-terminal, the frontend polls `transfer_list` every 4s and dispatches `transfer.reconcile` intents. The stated reason is that 'under memory pressure the webview can still miss the terminal event, leaving a seeded row stuck'. But transfersBridge.ts:229-235 documents that the backend now folds every `transfer-progress` sample and lifecycle step into the authoritative region itself (#2387, `fold_transfer_progress` in files/transfer/mod.rs:112 and relaunch.rs:968), so terminal state no longer passes through the webview.

## Why it matters

The backstop now hides any backend path that fails to fold a terminal state. Such a bug gets silently corrected by a client poll instead of being caught. It also makes a background IPC call every 4s from every open window during transfers, and it keeps a client-driven mutation path on a region that is meant to be server-authoritative.

## Evidence

- `src/hooks/useTransferReconcile.ts:15`
- `src/hooks/useTransferReconcile.ts:20`
- `src/hooks/useTransferReconcile.ts:23`
- `src/hooks/useTransferReconcile.ts:60`
- `src/store/transfersBridge.ts:229`
- `src/store/transfersBridge.ts:234`
- `src-tauri/src/files/transfer/mod.rs:112`
- `src-tauri/src/files/transfer/relaunch.rs:968`

## Recommendation

Confirm that every engine termination path (success, failure, cancel, relaunch, legacy SFTP) calls `fold_transfer_progress` with the terminal state, then retire the poll. Alternatively, move the reconcile server-side as a periodic or retention-time sweep in the transfers store. If a client backstop is kept, have it log at WARN whenever it actually changes a row, so backend fold gaps show up instead of being masked.

## Verification

Partially confirmed. useTransferReconcile.ts:17-24 still justifies the 4s poll with the webview missing the terminal event. But transfersBridge.ts:229-235 says the backend folds every progress sample itself (#2387), and TransferStore.progress upserts while seed() refuses to overwrite an existing row (store.rs:633-654), so the seed-after-terminal race is also handled. The stated rationale is stale. However, keeping a defensive backstop on a safety-critical app is a defensible choice, and no concrete masked bug was shown. Updating the comment, or logging when reconcile actually changes a row, is the real takeaway, so this is informational.
