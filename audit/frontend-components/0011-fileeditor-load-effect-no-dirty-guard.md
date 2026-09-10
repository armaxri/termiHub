---
id: FEC-011
title: FileEditor load effect can re-fire and overwrite unsaved edits with disk content (no dirty guard)
angle: frontend-components
severity: medium
category: bug
is_workaround: false
subsystem: src/components/FileEditor
evidence:
  - src/components/FileEditor/FileEditor.tsx:324
  - src/components/FileEditor/FileEditor.tsx:366
status: open
---

## What
The mount/load effect unconditionally does `setContent(text); setSavedContent(text)`
(and, at entry, `setLoading(true)`), with dependency array
`[meta.filePath, meta.isRemote, meta.sessionBrowser, meta.scratch, meta.scratchContent]`.
`meta.sessionBrowser` is an **object reference**; if the store hands back a new
`editorMeta`/`sessionBrowser` identity — plausible during the agent-reconnect /
session-lifecycle projection churn this app is built around — the effect re-runs
and replaces the user's in-progress edits with freshly-loaded disk content, with
no `isDirty` check.

## Why it matters
The component has explicit conflict protection for *external* disk changes
(`diskChangedWhileDirty`), but none for this internal reload path, so a store
identity change silently clobbers unsaved work. Impact is conditional on store
reference stability, hence medium, but the blast radius is unsaved data loss.

## Evidence
`src/components/FileEditor/FileEditor.tsx:324-366`.

## Recommendation
Guard the reload: if the buffer is dirty (`content !== savedContent`), do not
overwrite it — either skip the reload or route it through the same
`diskChangedWhileDirty` conflict UI. Alternatively key the effect on primitive
identity (a stable `watchId`/path string) rather than the `sessionBrowser`
object reference so it does not re-fire on identity churn.
