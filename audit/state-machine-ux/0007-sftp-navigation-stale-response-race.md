---
id: SM-007
title: SFTP navigation applies stale directory-list responses (no request-sequence guard)
angle: state-machine-ux
severity: medium
category: bug
is_workaround: false
subsystem: src/store/appStore.ts (file browser) + src/components/FileBrowser.tsx
evidence:
  - src/store/appStore.ts:6612
  - src/store/appStore.ts:6627
  - src/components/FileBrowser.tsx:1373
status: open
---

## What
`navigateSession` (`appStore.ts:6612-6625`) fires `fileBrowser.loadStarted`, `await`s
`sessionListFiles`, then **unconditionally** applies `fileBrowser.loadSucceeded{path,entries}`
when the promise resolves — with no monotonic request id, no abort, and no stale-response
drop. Navigation controls are not disabled during a pending list (`FileBrowser.tsx:1373`
disables "Up" only at root). `refreshSession` (`appStore.ts:6627-6643`) shares the pattern.

## Why it matters
Interleaving: the user double-clicks folder B while folder A's listing is still in flight; if
A's response resolves last, its `loadSucceeded` wins and the browser lands on folder A —
the folder the user already navigated away from — showing A's path and contents. The file
browser state ends up out of sync with the user's last action. Each response now carries its
own `{path, entries}` so path and list stay internally consistent (better than the old spec
R1 claim), but the **stale response still wins the final view**, an ambiguous/wrong-state
outcome on a common fast-navigation path.

## Evidence
- `appStore.ts:6612-6625` — `navigateSession` applies the resolved list unconditionally.
- `appStore.ts:6627-6643` — `refreshSession` same shape.
- `FileBrowser.tsx:1373` — nav not disabled during a pending list.

## Recommendation
Attach a monotonic nav/request id to each list request and drop any `loadSucceeded` whose id
is not the latest (last-write-wins by request order), or disable navigation while a list is
pending. The former preserves responsiveness; the latter is simpler.
