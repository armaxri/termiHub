# Broadcast Input (Multi-Execution)

**GitHub Issue:** [#516](https://github.com/armaxri/termiHub/issues/516)

> **Folder-form concept** (AI-driven concept workflow). Visual surfaces live in
> [`mockups/`](mockups/), behavior diagrams in [`behavior.md`](behavior.md), and the
> concept↔code reconciliation ledger in [`sync.md`](sync.md). The concept is the source of
> truth; run `/sync-concept broadcast-input` to reconcile it with the implementation.

---

## Overview

Broadcast input is a mode that sends keystrokes simultaneously to multiple terminal sessions.
Users type once and the input is mirrored to every selected terminal in real time. Each terminal
maintains independent output — only input is shared.

This is one of the most requested power-user features in terminal multiplexers (MobaXterm's
"MultiExec", iTerm2's "Send Input to All Panes", Terminator's "broadcast"). System administrators
frequently need to run the same command across a fleet of servers — applying patches, checking
status, restarting services — and doing this one terminal at a time is tedious and error-prone.

### Goals

- Allow users to type once and send input to multiple terminals simultaneously
- Provide clear visual feedback for which terminals are receiving broadcast input
- Support flexible target selection (all terminals, specific tabs, specific panels)
- Integrate naturally with the existing split view and tab system
- Keep the feature discoverable but unobtrusive for users who don't need it

### Non-Goals

- Synchronized output comparison (diff view across terminals)
- Command queuing or sequential execution across terminals
- Macro recording and playback (separate feature)
- Backend-side batching (frontend-driven loop over `sendInput` is sufficient)

---

## UI Interface

The visual surfaces are specified by the mockups — open them in a browser to review layout and
states. This section describes them; the mockups are authoritative for layout.

| Mockup                                                     | Shows                                                                        |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------- |
| [`mockups/toolbar.html`](mockups/toolbar.html)             | Toolbar toggle (inactive), active source/target feedback, no-targets warning |
| [`mockups/target-picker.html`](mockups/target-picker.html) | Scope dropdown and custom per-tab selection picker                           |

### Activation point

A **Broadcast** toggle (lucide `Radio` icon) sits in the terminal view toolbar, left of the
existing New / Split / Close buttons. Inactive → default style; active → accent background plus an
amber ring around participating panels. See `mockups/toolbar.html` states 1 and 2.

### Visual feedback when active

1. **Accent ring** around every participating panel; the **source** panel (where the user types)
   additionally gets a glow to distinguish it from targets.
2. **Tab badge** (●) next to each participating tab title, visible even when the tab is inactive.
3. **Status-bar pill** showing the mode is active and the target count; clicking it stops
   broadcast. If all targets disconnect, the pill becomes a warning (`mockups/toolbar.html`
   state 3).

### Target selection

Clicking the broadcast button opens a **scope dropdown** (All terminals / Current panel / Custom
selection) before activating. "Custom selection" opens a per-tab checkbox picker. Non-terminal
tabs (file editor, SFTP) never appear as targets. See `mockups/target-picker.html`.

### Keyboard shortcut

`Ctrl+Shift+B` (Windows/Linux) / `Cmd+Shift+B` (macOS) toggles broadcast using the **last used
scope** (defaulting to "All terminals" on first use), skipping the dropdown.

### Per-terminal exclude & ending

Each target's broadcast button is a local toggle — clicking it excludes that one terminal without
ending the session. Broadcast ends when the user toggles it off on the source, presses the
shortcut, closes the source tab, or clicks "Stop" in the status-bar pill.

---

## General Handling

Detailed flows, the input routing path, session filtering, and edge cases are diagrammed in
[`behavior.md`](behavior.md). Key rules:

- **Only connected terminal sessions** receive input. Disconnected/connecting sessions and
  non-terminal tabs are skipped silently.
- **New terminals during broadcast**: added automatically under "All terminals"; under "Current
  panel" only if in that panel; never under "Custom selection".
- **Closed terminals**: silently removed; closing the **source** ends broadcast entirely.
- **Paste** goes through the same `onData` path and is therefore broadcast like typed input.
- Chord-shortcut keystrokes are consumed by the shortcut system and are not broadcast.

---

## Preliminary Implementation Details

Based on the current project architecture at concept-creation time; the codebase may evolve before
implementation. The architecture diagram lives in [`behavior.md`](behavior.md).

### New and Modified Files

| File                                           | Change                                                                    |
| ---------------------------------------------- | ------------------------------------------------------------------------- |
| `src/store/appStore.ts`                        | **Modify** — Add broadcast state and actions                              |
| `src/components/Terminal/Terminal.tsx`         | **Modify** — Hook into `onData` to check broadcast state and mirror input |
| `src/components/Terminal/TerminalRegistry.tsx` | **Modify** — Expose method to enumerate all session IDs for broadcast     |
| `src/components/SplitView/TerminalView.tsx`    | **Modify** — Add broadcast toggle button to toolbar                       |
| `src/components/StatusBar/StatusBar.tsx`       | **Modify** — Add broadcast status indicator                               |
| `src/components/StatusBar/BroadcastStatus.tsx` | **New** — Broadcast indicator component for status bar                    |
| `src/hooks/useKeyboardShortcuts.ts`            | **Modify** — Add `toggle-broadcast` action                                |
| `src/types/terminal.ts`                        | **Modify** — Add broadcast-related type definitions                       |
| `src/styles/broadcast.css`                     | **New** — Broadcast-specific styles (borders, badges, button states)      |

### Store State Design

```typescript
interface BroadcastState {
  /** Whether broadcast mode is currently active */
  broadcastActive: boolean;
  /** The tab ID of the terminal where the user types (source of input) */
  broadcastSourceTabId: string | null;
  /** The scope used for the current broadcast session */
  broadcastScope: "all" | "panel" | "custom";
  /** Set of tab IDs that are broadcast targets */
  broadcastTargetTabIds: Set<string>;
  /** Last used scope (persisted for keyboard shortcut toggle) */
  lastBroadcastScope: "all" | "panel" | "custom";
}

interface BroadcastActions {
  startBroadcast: (
    scope: "all" | "panel" | "custom",
    sourceTabId: string,
    targetTabIds: string[]
  ) => void;
  stopBroadcast: () => void;
  addBroadcastTarget: (tabId: string) => void;
  removeBroadcastTarget: (tabId: string) => void;
  isBroadcastTarget: (tabId: string) => boolean;
}
```

### Input Mirroring

Broadcast hooks the existing `xterm.onData` handler in `Terminal.tsx`. When broadcast is active
and the terminal is the source, input is dispatched to every connected target session via the
existing `sendInput` Tauri command (fire-and-forget, dispatched in parallel). The source is
included in `broadcastTargetTabIds`, so it is just another target — keeping the loop uniform.

```typescript
xterm.onData((data) => {
  const state = useAppStore.getState();
  const currentTabId = tabIdRef.current;

  if (state.broadcastActive && state.broadcastSourceTabId === currentTabId) {
    for (const targetTabId of state.broadcastTargetTabIds) {
      const targetSessionId = sessionRegistryRef.current.get(targetTabId);
      if (targetSessionId) sendInput(targetSessionId, data);
    }
  } else {
    sendInput(sessionIdRef.current, data);
  }
});
```

### Performance

- **No backend changes needed**: `sendInput()` in a loop (one IPC call per target) is sufficient —
  sub-millisecond per call. Calls are fire-and-forget and dispatched in one microtask.
- **Scaling limit**: for very large groups (50+), a batch `sendInputMultiple(sessionIds[], data)`
  command could be added later. Optimization only — not needed for v1.

### Implementation Order

1. Core broadcast state + input mirroring (store, `Terminal.tsx`, registry `getAllSessions`).
2. Toolbar button + scope dropdown (all / panel / custom).
3. Visual indicators (panel rings, tab badges, `BroadcastStatus`).
4. Keyboard shortcut + last-scope memory.
5. Polish & edge cases (new/closed terminals, session filtering, custom picker).

---

## Implementation Status

Not started — this is a `backlog/` concept. It is the first concept migrated to the folder form
as the worked example for the AI-driven concept workflow. Once implementation begins, run
`/sync-concept broadcast-input` after each change to keep [`sync.md`](sync.md) current.
