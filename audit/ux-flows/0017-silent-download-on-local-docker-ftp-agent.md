---
id: UX-017
title: Download from local / Docker / FTP / agent file browsers succeeds or fails silently
angle: ux-flows
severity: medium
category: ux
is_workaround: false
subsystem: src/components/Sidebar/FileBrowser
evidence:
  - src/components/Sidebar/FileBrowser.tsx:1027
  - src/hooks/useLocalFileSystem.ts:116
  - src/hooks/useSessionFileSystem.ts:150
status: open
---

## What
The file browser's "Download" context action runs `void downloadFile(entry.path, entry.name)`
(`FileBrowser.tsx:1027-1029`) with a comment claiming "downloadFile surfaces its own success/error
toast." That is only true for the **SFTP** path (`useSessionFileSystem.ts:141-148` routes through
`runTransfer`). The other backends give no feedback:
- Local (Save-as copy): `useLocalFileSystem.ts:116-123` returns with **no success toast**, and the
  call site has **no `.catch`** → a failure is a silent unhandled rejection.
- Byte-based session fallback (Docker / FTP / remote-agent): `useSessionFileSystem.ts:150-153` reads
  then writes with **no success toast**; on error, again nothing (no `.catch` at
  `FileBrowser.tsx:1029`).

So the same "Download" menu item gives a proper pending/success/error toast on SSH but is entirely
silent on local and Docker/FTP/agent — success and failure both.

## Why it matters
The user cannot tell whether a Docker/local/FTP download worked or failed. A failed download shows
nothing at all. This is a silent-failure gap on a common action, and it is inconsistent across
backends for an identical menu item.

## Evidence
- `FileBrowser.tsx:1027-1029` — fire-and-forget `downloadFile`, no `.catch`.
- `useLocalFileSystem.ts:116-123` — local copy, no toast.
- `useSessionFileSystem.ts:150-153` — byte-based path, no toast.

## Recommendation
Route every `downloadFile` backend through the shared `runTransfer` feedback contract (or add
explicit success/error toasts to the local and byte-based paths), and add a `.catch` at the call
site so a rejection can never go unreported.
