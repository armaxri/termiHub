---
id: UX-013
title: Stored credential silently discarded on auth failure, then re-prompt with no notice
angle: ux-flows
severity: low
category: ux
is_workaround: false
subsystem: src/hooks/useConnectSavedConnection
evidence:
  - src/hooks/useConnectSavedConnection.ts:165
status: fixed
resolution: "#2817 — rejected stored cred → re-prompt subtitle notice (passwordPromptNotice); typed-code gating kept"
---

## What
On the sidebar connect path, when a connect using a stored credential fails with an `auth failed`
error, the hook silently removes the stored credential and falls through to prompt the user again
(`useConnectSavedConnection.ts:165-172`). Any other error just opens the tab and delegates to the
Terminal overlay (`:174-179`). The credential-clear is silent — the user is re-prompted for a
password with no indication that their previously-saved credential was discarded as stale.

## Why it matters
A user whose saved password was auto-cleared gets re-prompted with no explanation, and if they
re-enter and save, fine — but if the failure was transient (not really a bad password), the app has
thrown away a valid stored secret behind their back. At minimum the user should be told the saved
credential was cleared.

## Evidence
- `useConnectSavedConnection.ts:165-172` — auth-failed → silent credential removal → re-prompt.
- `useConnectSavedConnection.ts:174-179` — other errors → open tab, no notice of fallback.

## Recommendation
When clearing a stored credential after an auth failure, tell the user ("Saved credential was
rejected and removed — please re-enter"). Consider not auto-clearing on the *first* failure to
avoid discarding a good credential on a transient error.
