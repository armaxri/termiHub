---
id: FEC-004
title: TransferQueue pause/resume/cancel/retry show success even when the IPC call fails
angle: frontend-components
severity: high
category: bug
is_workaround: false
subsystem: src/components/TransferQueue
evidence:
  - src/components/TransferQueue/TransferQueue.tsx:45
  - src/components/TransferQueue/TransferQueue.tsx:57
status: fixed
resolution: "#2816 — TransferQueue: registry bool threaded cmd→api→UI; success only on true, info on no-op, error on reject"
---

## What
The four per-row transfer actions `await` the backend command and then
unconditionally raise a success toast, with **no** try/catch:

```ts
const handlePause = async (id: string) => {
  await transferPause(id);
  toast.success("Transfer paused");
};
```
The same shape is used for `handleResume`, `handleCancel`, and `handleRetry`.

## Why it matters
If `transferPause`/`transferResume`/`transferCancel`/`transferRetry` rejects
(backend error, session already gone, agent dropped), two things happen: (1) the
success toast never fires but **no error toast fires either**, so the user gets
no feedback that the action failed — they believe a transfer was cancelled when
it was not; and (2) the rejection becomes an unhandled promise rejection. This
violates the project's own feedback contract ("every mutating/async action …
success or a recoverable error"). The sibling `handleCancelAll` in the same file
does it correctly with `Promise.allSettled` + an error toast, so this is an
inconsistency, not a limitation. On a safety-critical transfer path, silently
failing a cancel is a real defect.

## Evidence
`src/components/TransferQueue/TransferQueue.tsx:45-60` (no error handling)
vs. the correct pattern at `:62-73` (`handleCancelAll` counts rejections and
toasts on failure).

## Recommendation
Wrap each handler in try/catch (or await-and-check) and raise
`toast.error(...)` on failure, mirroring `handleCancelAll`. Better, route these
through the shared async-Button pending/error affordance so the failure is
attached to the control the user clicked.
