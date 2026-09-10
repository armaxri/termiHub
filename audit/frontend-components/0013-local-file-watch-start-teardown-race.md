---
id: FEC-013
title: watchLocalFile start races its unwatch teardown, leaking an OS file/dir watch on fast unmount
angle: frontend-components
severity: medium
category: reliability
is_workaround: false
subsystem: src/components/FileEditor
evidence:
  - src/components/FileEditor/FileEditor.tsx:640
  - src/hooks/useLocalDirWatch.ts:49
status: open
---

## What
The local-file watch effect does `await watchLocalFile(watchId, filePath)` then
subscribes to `onLocalFileChanged`. The event-listener race is handled with a
`disposed` flag, but the *watch registration itself* is not: if the effect tears
down while `await watchLocalFile(...)` is still in flight, cleanup calls
`unwatchLocalFile(watchId)` which can reach the backend **before** the watch
finishes registering — leaving a live OS watch keyed to `watchId` that is never
torn down. The same shape is in `useLocalDirWatch.ts:49-83`.

## Why it matters
On fast mount/unmount or rapid `effectivePath` changes (both common as the user
clicks around a file tree), each lost race leaks a backend file-system watcher.
These accumulate silently — a resource leak with no user-visible signal, in
exactly the file-browser/editor flows a user exercises most.

## Evidence
`src/components/FileEditor/FileEditor.tsx:640-676`,
`src/hooks/useLocalDirWatch.ts:49-83`.

## Recommendation
Track completion of the `watchLocalFile` promise (or a `disposed`/`started`
flag) and only call `unwatchLocalFile` once registration has actually resolved;
if teardown happens first, chain the unwatch onto the start promise so it runs
after the watch exists. (The `.catch(()=>{})` on unwatch is documented
best-effort and is fine once ordering is correct.)
