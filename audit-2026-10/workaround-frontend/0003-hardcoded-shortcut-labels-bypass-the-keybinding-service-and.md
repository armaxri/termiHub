---
id: WA-FE2-003
title: "Hardcoded shortcut labels bypass the keybinding service and show the wrong keys (Toggle Sidebar shows Ctrl+B on Win/Linux)"
angle: workaround-frontend
severity: low
category: workaround
is_workaround: true
subsystem: "components/Terminal, SplitView, FileEditor (keybinding display)"
evidence:
  - src/components/Terminal/TerminalView.tsx:309
  - src/components/Terminal/TerminalView.tsx:310
  - src/components/Terminal/TerminalView.tsx:554
  - src/services/keybindings.ts:22
  - src/services/keybindings.ts:26
  - src/services/keybindings.ts:27
  - src/components/Terminal/TabGroupChips.tsx:77
  - src/components/Terminal/TabGroupChips.tsx:81
  - src/services/keybindings.ts:320
  - src/components/SplitView/SplitView.tsx:506
  - src/components/FileEditor/FileEditor.tsx:1700
  - src/components/FileEditor/FileEditor.tsx:1701
  - src/services/keybindings.ts:660
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: new
---

## What

Several tooltips and hints build shortcut text by hand instead of calling `getActionAccelerator(action)` (keybindings.ts:660), which is documented as the single source of truth. Some are wrong even with default settings. TerminalView.tsx:309-310 sniffs the deprecated `navigator.platform` and renders `Toggle Sidebar (Ctrl+B)` on Windows/Linux, but the real default there is Ctrl+Shift+B (keybindings.ts:26-27; it was moved off Ctrl+B because Ctrl+B is the tmux prefix). TabGroupChips.tsx:77/81 always shows `Ctrl+Shift+T`, even on macOS where the default is Cmd+Shift+T (keybindings.ts:320). SplitView.tsx:506 (zoom hint) and FileEditor.tsx:1700-1701 (`Save (Ctrl+S)`) are also hardcoded. None of these labels reflect a user's keybinding override.

## Why it matters

On the main terminal toolbar, every Windows/Linux user is told to press Ctrl+B. That key goes to the shell or tmux instead of toggling the sidebar, so the tooltip itself is a bug. Labels that ignore user overrides drift silently whenever a default or binding changes. ActivityBar's MenuAccelerator already uses the correct helper, so the same information is shown inconsistently across the app.

## Evidence

- `src/components/Terminal/TerminalView.tsx:309`
- `src/components/Terminal/TerminalView.tsx:310`
- `src/components/Terminal/TerminalView.tsx:554`
- `src/services/keybindings.ts:22`
- `src/services/keybindings.ts:26`
- `src/services/keybindings.ts:27`
- `src/components/Terminal/TabGroupChips.tsx:77`
- `src/components/Terminal/TabGroupChips.tsx:81`
- `src/services/keybindings.ts:320`
- `src/components/SplitView/SplitView.tsx:506`
- `src/components/FileEditor/FileEditor.tsx:1700`
- `src/components/FileEditor/FileEditor.tsx:1701`
- `src/services/keybindings.ts:660`

## Recommendation

Replace each hand-built label with `getActionAccelerator("toggle-sidebar" | "new-tab-group" | "zoom-panel" | ...)`, and omit the parenthetical when it returns null. Delete the `navigator.platform` sniff in TerminalView. For the FileEditor Save hint, use Monaco's Cmd/Ctrl rendering or the platform util. Add a lint or grep guard that rejects `Ctrl+`/`Cmd+` literals inside `title=`/`aria-label=`/`content=` attributes in src/components.

## Verification

Confirmed. TerminalView.tsx:309-310 sniffs navigator.platform and renders 'Toggle Sidebar (Ctrl+B)' on Win/Linux, but keybindings.ts:26-27 makes the default Ctrl+Shift+B ('Avoid Ctrl+B: tmux default prefix key'). TabGroupChips.tsx:77/81 hardcodes 'Ctrl+Shift+T' even though the macOS default is Cmd+Shift+T. SplitView.tsx:506 and FileEditor.tsx:1700-1701 are also hardcoded, and getActionAccelerator (keybindings.ts:660) is documented as the single source of truth. Rated low, not medium: these are tooltip text only. Following the wrong hint just sends Ctrl+B to the shell, with no data loss.
