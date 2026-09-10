---
id: UX-012
title: Cancelling the password prompt on a sidebar connect gives no feedback
angle: ux-flows
severity: low
category: ux
is_workaround: false
subsystem: src/hooks/useConnectSavedConnection
evidence:
  - src/hooks/useConnectSavedConnection.ts:189
  - src/components/ConnectionEditor/ConnectionEditor.tsx:988
status: open
---

## What
On the sidebar connect path, cancelling the password prompt just returns silently
(`useConnectSavedConnection.ts:189` `if (password === null) return;` and `:205`). The editor path,
by contrast, explicitly surfaces `toast.info("Connect canceled — your changes were saved.")`
(`ConnectionEditor.tsx:988,1008`). So the same user action (cancel a connect's password prompt)
gives an acknowledgement in one place and nothing in the other.

## Why it matters
Inconsistent feedback for the same gesture. Cancelling from the sidebar leaves no confirmation the
connect was aborted — minor, but it fails the "every action gives feedback" consistency bar and
can leave the user unsure whether anything is still happening.

## Evidence
- `useConnectSavedConnection.ts:189,205` — silent return on cancel.
- `ConnectionEditor.tsx:988,1008` — editor path toasts on cancel.

## Recommendation
Emit a lightweight `toast.info("Connect canceled")` on the sidebar cancel path, matching the editor
path.
