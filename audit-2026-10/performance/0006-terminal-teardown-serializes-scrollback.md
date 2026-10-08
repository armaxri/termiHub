---
id: PERF2-006
title: "Every Terminal effect teardown serializes the whole scrollback, including final tab close"
angle: performance
severity: low
category: perf
is_workaround: false
subsystem: src/components/Terminal/Terminal.tsx
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: new
evidence:
  - src/components/Terminal/Terminal.tsx:1874
  - src/components/Terminal/Terminal.tsx:1875
  - src/components/ConnectionEditor/ConnectionTerminalSettings.tsx:269
  - src/components/Settings/TerminalSettings.tsx:63
---

## What

The xterm effect cleanup always runs `serializeAddon.serialize()` over the entire buffer and stores the result in `scrollbackSnapshotRef` (1874). The snapshot is only needed when the effect re-runs (reconnect via retryCount). The cleanup also runs on final unmount (tab close, group close, window close), where the component is discarded and the multi-MB string is thrown away. Scrollback can be set as high as 1,000,000 lines (TerminalSettings.tsx:63, ConnectionTerminalSettings.tsx:269).

## Why it matters

Serializing is synchronous on the main thread and grows with scrollback × columns, including SGR re-encoding. With the default 10k lines it costs tens of ms per tab. Closing a group of many tabs, or one tab with a large configured scrollback, can stall the UI for hundreds of ms to seconds and briefly allocate large strings, all for output nobody reads.

## Evidence

- `src/components/Terminal/Terminal.tsx:1874`
- `src/components/Terminal/Terminal.tsx:1875`
- `src/components/ConnectionEditor/ConnectionTerminalSettings.tsx:269`
- `src/components/Settings/TerminalSettings.tsx:63`

## Recommendation

Only take the snapshot when the teardown is for a reconnect or re-run: check a `closingRef` / `isUnmountingRef` set by the tab-close path, or move the snapshot into the reconnect trigger itself. Optionally cap the snapshot with `serialize({ scrollback: N })`.

## Verification

Confirmed. The effect cleanup always runs serializeAddon.serialize() into scrollbackSnapshotRef. That ref belongs to the component instance and is lost on final unmount, so on tab close the work is wasted. Moves between panels use parking rather than unmounting, so the snapshot is only ever useful for the retryCount reconnect re-run. The cost scales with the configured scrollback, which can be up to 1M lines. Low severity is right.
