---
id: FEC-017
title: useTransferEvents registers listeners via async setup with no disposed-guard, leaking on unmount-during-setup
angle: frontend-components
severity: low
category: reliability
is_workaround: false
subsystem: src/hooks
evidence:
  - src/hooks/useTransferEvents.ts:85
  - src/hooks/useTransferEvents.ts:45
status: open
---

## What
`useTransferEvents` registers its Tauri listeners inside an async `setup()` that
`void`-fires, assigning `unlisten`/`unlistenOwnership` only after the awaits
resolve. The cleanup calls `unlisten?.()` / `unlistenOwnership?.()`, but if the
effect tears down **before** `setup()`'s awaits complete, both are still `null`,
so the listeners registered moments later are never removed — a listener leak.
This is the same async-registration race that `useRemoteDesktopSession` /
`RemoteDesktopCanvas` explicitly guard against with a `disposed` flag +
`.then(un => disposed ? un() : unlisteners.push(un))`; this hook lacks that guard.

Separately, `scheduleOwnersRefresh` uses a **module-scoped** timer
(`ownersRefreshTimer`) that the effect cleanup never clears, so a pending refresh
can fire after the hook unmounts.

## Why it matters
`useTransferEvents` is an app-level singleton that rarely unmounts, so real-world
impact is low — but it establishes the *unguarded* async-listen pattern next to
the guarded one, and the two `transfer-progress`/`ownership` listeners are on a
per-chunk hot path, so a duplicate registration (e.g. StrictMode churn during
dev) doubles the fold/toast work.

## Evidence
`src/hooks/useTransferEvents.ts:77-113` (no disposed guard), `:45-53` (module
timer never cleared on unmount).

## Recommendation
Adopt the `disposed`-flag pattern used by the RemoteDesktop hooks so late-
resolving registrations are immediately unlistened; clear `ownersRefreshTimer` in
the cleanup (or scope it to the hook instance).
