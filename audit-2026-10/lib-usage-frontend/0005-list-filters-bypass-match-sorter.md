---
id: LIBFE2-005
title: "About 15 list filters hand-roll lowercase substring matching while the shared match-sorter helper exists"
angle: lib-usage-frontend
severity: info
category: ux
is_workaround: false
subsystem: "src (filter UIs)"
status: fixed
resolution: "#4372 — useListFilter delegates to textFieldsMatchQuery; Quick Connect, Recent Sessions and the workspace ConnectionPicker use it"
audit: 2026-10
commit: "663465d52"
relation: new
evidence:
  - src/utils/searchMatching.ts:19
  - src/components/RecentSessionsSidebar/QuickConnectBar.tsx:55
  - src/components/RecentSessionsSidebar/RecentSessionsSidebar.tsx:32
  - src/components/WorkspaceEditor/ConnectionPicker.tsx:21
  - src/hooks/useListFilter.ts:30
  - src/components/KeyboardShortcuts/ShortcutsOverlay.tsx:23
  - src/components/ConnectionEditor/IconPickerDialog.tsx:22
  - src/components/Settings/KeyPathInput.tsx:69
---

## What

LIBFE-004 (fixed) moved the sidebar tree search onto match-sorter through `textFieldsMatchQuery`, which gives diacritic-insensitive matching. Every other filter still uses `x.toLowerCase().includes(q)`, including Quick Connect, Recent Sessions, the workspace ConnectionPicker, the shortcuts overlay, the icon picker, plugin and language-pack lists, LogViewer, open ports and `useListFilter`. The same connection is therefore found by `muller` in the sidebar but not in Quick Connect or the workspace picker.

## Why it matters

Search behaves inconsistently across surfaces that list the same entities, and a separate hand-rolled `useListFilter` duplicates a predicate the shared helper already provides. This is not a correctness bug.

## Recommendation

Have `useListFilter` delegate to `textFieldsMatchQuery`, then route the connection- and session-listing filters (QuickConnectBar, RecentSessionsSidebar, ConnectionPicker) through it first. Leave LogViewer and open-ports on plain substring matching if exact-substring semantics are wanted there.

## Verification

Confirmed. textFieldsMatchQuery wraps match-sorter, but nameDescriptionTagsMatcher in useListFilter and QuickConnectBar:55 use toLowerCase().includes(). That makes diacritic handling inconsistent across surfaces. It is a UX consistency issue, not a bug, and LIBFE-006 does not exempt it.
