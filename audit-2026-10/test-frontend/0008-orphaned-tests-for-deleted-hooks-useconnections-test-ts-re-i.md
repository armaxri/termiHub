---
id: TFE2-008
title: "Orphaned tests for deleted hooks: useConnections.test.ts re-implements a hook removed in 2c77e62a9"
angle: test-frontend
severity: low
category: test-quality
is_workaround: false
subsystem: "src/hooks/*.test.ts"
evidence:
  - src/hooks/useConnections.test.ts:39-65
  - src/hooks/useConnections.test.ts:69
  - src/hooks/useTerminal.test.ts:37
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: new
---

## What

src/hooks/useConnections.ts and src/hooks/useTerminal.ts were deleted in 2c77e62a9 (2026-09-30, "remove unused barrels, hooks"), but their test files remain. useConnections.test.ts says "Re-implement the hook logic under test" and defines `simulateCreateConnection` / `simulateCreateFolder` (copies of the deleted hook), then asserts on those copies. useTerminal.test.ts describes itself as "useTerminal logic (via store)" for a hook that no longer exists.

## Why it matters

These tests verify code that does not ship. They inflate the test count and imply coverage of hooks that are gone, and the re-implementation pattern is what lets real logic drift unnoticed (see the TerminalView finding). The useful parts are store passthrough checks that belong with the store tests.

## Evidence

- `src/hooks/useConnections.test.ts:39-65`
- `src/hooks/useConnections.test.ts:69`
- `src/hooks/useTerminal.test.ts:37`

## Recommendation

Delete the simulate\* sections of useConnections.test.ts. Move any still-useful store assertions (addConnection/addFolder id prefix, passthroughs) into the matching store/connectionsBridge tests, and rename or move useTerminal.test.ts under src/store/. Optionally add a guard test or lint check that fails when `<stem>.test.ts(x)` has no `<stem>.ts(x)` sibling and does not import its subject.

## Verification

Confirmed. src/hooks/ now contains only useConnections.test.ts and useTerminal.test.ts, with no useConnections.ts or useTerminal.ts; commit 2c77e62a9 is 'chore(ui): remove unused barrels, hooks and projection cache'. useConnections.test.ts says it re-implements the hook logic and asserts on its local simulate\* copies. useTerminal.test.ts is titled for a hook that no longer exists. This is test-quality hygiene, so low.
