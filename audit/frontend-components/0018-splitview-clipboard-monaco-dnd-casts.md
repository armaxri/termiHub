---
id: FEC-018
title: SplitView — fire-and-forget clipboard write, zoom double-mounts one Monaco model, unchecked dnd-kit casts
angle: frontend-components
severity: low
category: bug
is_workaround: false
subsystem: src/components/SplitView
evidence:
  - src/components/SplitView/SplitView.tsx:717
  - src/components/SplitView/SplitView.tsx:462
  - src/components/SplitView/SplitView.tsx:163
status: fixed
resolution: "#2808 — clipboard await/catch+toast; zoom hidden copy dormant (skips watch/poll/status, avoids shared-model dispose); dnd casts guarded"
---

## What
Three lower-severity correctness issues in `SplitView.tsx`:

1. **Fire-and-forget clipboard write** (`:717-719`): `writeClipboard(selection)`
   is neither awaited nor `.catch`-ed, and `clearTerminalSelection(tabId)` runs
   regardless. A clipboard IPC failure is a silent unhandled rejection and the
   selection is cleared anyway, so the user believes they copied when they may
   not have — violating the "every action gives feedback" rule.
2. **Zoom double-mounts one Monaco model** (`:462-469` zoom overlay with
   `keepModel`, `:761-767` in-panel copy left mounted with `isVisible=false`):
   while a file tab is zoomed, two `FileEditor` instances are mounted for the same
   tab and the same `monacoPath`, coupling them to one Monaco model URI. Both run
   the load effect, both register a backend file watch (two watches on one file),
   and both drive the **global** `setEditorStatus`/`setEditorActions` singleton —
   effect ordering between them can momentarily null or cross-set the status bar.
3. **Unchecked structural casts on dnd-kit data** (`:163,181,182,190-191`,
   `443-445`, `832-834`): `event.active.id as string` (ids are `string | number`),
   `active.data.current as { panelId?: string }`, `event.activatorEvent as
   PointerEvent`, and `zoomedTab.config.config as { sessionType?: string }` —
   narrowing casts with no runtime validation. Safe under the current
   PointerSensor-only config but brittle if a keyboard/touch sensor is added.

## Why it matters
Individually low, but (1) is a silent-failure on a user action, and (2) is
fragile global+Monaco coupling in the same reparenting machinery that has caused
repeated terminal-adoption bugs. Worth cleaning before release.

## Evidence
`src/components/SplitView/SplitView.tsx:717-719, 462-469, 761-767, 163-191,
443-445, 832-834`.

## Recommendation
Await/catch the clipboard write and only clear the selection on success (or toast
on failure). For zoom, mount a single `FileEditor` and portal its DOM into the
overlay rather than mounting a second instance on the same model URI. Validate
dnd-kit ids/events (`String(id)`, an `instanceof PointerEvent` check) instead of
asserting.
