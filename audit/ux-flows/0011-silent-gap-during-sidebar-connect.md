---
id: UX-011
title: Sidebar connect shows no feedback during credential resolve + blocking pre-connect
angle: ux-flows
severity: medium
category: ux
is_workaround: false
subsystem: src/hooks/useConnectSavedConnection
evidence:
  - src/hooks/useConnectSavedConnection.ts:129
  - src/hooks/useConnectSavedConnection.ts:157
  - src/hooks/useConnectSavedConnection.ts:44
status: fixed
resolution: "#2817 — toast.loading during slow sidebar pre-connect, dismissed on openTab/cancel"
---

## What
Connecting a saved SSH connection from the sidebar / command palette performs a sequence of
potentially slow steps **before any tab or overlay is shown**: `isSshKeyEncrypted` (`:99`),
`ensureCredentialStoreUnlocked` (`:129`), `resolveConnectionCredential` (`:133`), then a **blocking
pre-connect** `await createTerminal(preConfig)` to validate the stored credential (`:157`). The tab
— and its `TerminalConnectionOverlay` — is only opened after that succeeds (`openTab` at `:159`).
The hook renders no spinner or toast of its own; its JSDoc explicitly states "contains no UI"
(`:44-46`).

## Why it matters
Between the user's click and the tab appearing there is a dead interval during which a full SSH
handshake may run (the pre-connect validation). On a slow host this looks like nothing happened,
so the user may click again. This violates the project's own "every action gives feedback" rule for
the pre-connect window — the well-built connect overlay exists but is shown too late to cover it.

## Evidence
- `useConnectSavedConnection.ts:129-159` — unlock → resolve → blocking `createTerminal` before
  `openTab`.
- `useConnectSavedConnection.ts:44-46` — JSDoc: "contains no UI".

## Recommendation
Show immediate feedback the moment connect is invoked — either open the tab with the connection
overlay *first* (before the pre-connect probe) or show a `toast.loading`/pending state during the
unlock+resolve+pre-connect window, dismissed when the tab/overlay takes over.
