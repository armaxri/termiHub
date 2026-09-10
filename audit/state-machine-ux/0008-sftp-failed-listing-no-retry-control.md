---
id: SM-008
title: SFTP failed-listing placeholder has no Retry/Dismiss control
angle: state-machine-ux
severity: low
category: ux
is_workaround: false
subsystem: src/components/FileBrowser.tsx
evidence:
  - src/components/FileBrowser.tsx:1319
  - src/components/FileBrowser.tsx:1547
status: open
---

## What
The session file-browser connecting/error placeholder (`FileBrowser.tsx:1310-1330`, esp.
`:1319-1323`) renders only an `AlertCircle` + `{error}` text with **no Retry / Dismiss /
Close affordance**; in-list errors (`:1547-1552`) likewise. There is no in-panel way to
re-drive a failed directory listing without touching the owning terminal session.

## Why it matters
This is the residual of spec gap S1 (failed-connect dead-end). It is materially softer than
the old dead-end because the browser now reflects the owning SSH session's lifecycle and
recovery rides the session reconnect path — but a user who hits a transient listing failure
(permission blip, path vanished) is stuck looking at an error with no button to retry the
listing; their only recourse is to renavigate or reconnect the whole session.

## Evidence
- `FileBrowser.tsx:1319-1323` — error placeholder is icon + text only.
- `FileBrowser.tsx:1547-1552` — in-list error, no retry.

## Recommendation
Add a Retry button to the error placeholder that re-issues the last list request for the
current path, plus a Dismiss to clear a transient in-list error.
