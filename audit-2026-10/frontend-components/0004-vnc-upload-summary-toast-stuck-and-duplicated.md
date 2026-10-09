---
id: FEC2-004
title: "VNC upload summary can stay on its loading toast forever, and per-file toasts duplicate it"
angle: frontend-components
severity: low
category: correctness
is_workaround: false
subsystem: "src/components/RemoteDesktop/fileTransfer"
evidence:
  - src/components/RemoteDesktop/fileTransfer.ts:118-146
  - src/components/RemoteDesktop/fileTransfer.ts:174
  - src/components/RemoteDesktop/fileTransfer.ts:216-234
  - src/hooks/useTransferEvents.ts:26-38
  - src/hooks/useTransferEvents.ts:129
status: fixed
resolution: "#4348 — summary watch has an inactivity bound + session abort, listener rejection handled, per-file toasts suppressed for batches"
audit: 2026-10
commit: 663465d52
relation: new
---

## What

`uploadToRemoteDesktop` registers a module-level `transfer-progress` listener (`watchSettlement`) that unsubscribes only after every queued transfer id reaches done, error or cancelled. It has no timeout and is not tied to the tab or session lifetime. If a transfer never emits a terminal phase (left paused, dropped from the registry, or an event missed while the window was not the owner), the listener lives for the rest of the app session and the 'Uploading N files…' loading toast never resolves. If `onTransferProgress` rejects at line 174, it happens outside the try block, so the loading toast is also left behind. Separately, the global `useTransferEvents` handler raises a 'Uploaded <file>' or 'Upload of <file> failed' toast for every transfer, graphical sessions included. A 30-file drop therefore shows 30 per-file toasts plus the summary toast this module is meant to replace.

## Why it matters

The user is left with a spinner toast that never clears, or a flood of duplicate toasts. Each stuck upload also leaks a global listener. This undercuts the module's stated goal of 'one summary'.

## Evidence

- `src/components/RemoteDesktop/fileTransfer.ts:118-146`
- `src/components/RemoteDesktop/fileTransfer.ts:174`
- `src/components/RemoteDesktop/fileTransfer.ts:216-234`
- `src/hooks/useTransferEvents.ts:26-38`
- `src/hooks/useTransferEvents.ts:129`

## Recommendation

Bound `watchSettlement` with a timeout or abort, and resolve the toast to a neutral 'see Transfers' state. Tie it to the tab or session (stop it on session close). Wrap the `await watchSettlement()` call in the try block. Suppress the per-file toasts in `toastTerminalPhase` for transfers that are seeded as part of a remote-desktop batch, for example with a seed flag or a session-kind check.

## Verification

Confirmed. `toastTerminalPhase` in `useTransferEvents.ts` toasts every done/error transfer and never checks whether it belongs to a remote-desktop batch, so an N-file drop shows N per-file toasts plus the summary. `watchSettlement` has no timeout and is not tied to the session; a transfer that never reaches a terminal phase leaves the loading toast and the listener in place. `await watchSettlement()` (line 174) runs before the try block, so a rejection there leaves the loading toast behind. All edge cases with UX-only impact, so low.
