---
id: TFE-008
title: File-system hooks nearly untested (useSessionFileSystem 8%B, useLocalFileSystem/useFileSystem 37%B)
angle: test-frontend
severity: medium
category: test-gap
is_workaround: false
subsystem: src/hooks
evidence:
  - src/hooks/useSessionFileSystem.ts
  - src/hooks/useLocalFileSystem.ts
  - src/hooks/useFileSystem.ts
  - coverage/clover.xml
status: open
---

## What

The file-system hooks that back the FileBrowser / FileEditor are among the
least-covered non-trivial modules in the frontend:

| Hook | Line | Branch | Conditionals |
|---|---|---|---|
| `useSessionFileSystem.ts` | 33% | **8%** | 61 |
| `useFileSystem.ts` | 64% | **37%** | 73 |
| `useLocalFileSystem.ts` | 73% | **37%** | 46 |

`useSessionFileSystem.ts` at **8% branch (5 of 61 conditionals)** is effectively
untested despite having a `useSessionFileSystem.test.ts` file — the test exercises a
narrow slice. These hooks mediate remote/local file operations: list, read, write,
rename, delete, sudo-escalation, external-change detection.

## Why it matters

File operations are destructive (rename/delete/overwrite) and run against remote
hosts. The untested 92% of `useSessionFileSystem`'s branches are the error handling,
permission-denied/sudo paths, and path-edge cases — exactly where a mishandled branch
means data loss or a wrong-file write on a production server. The `FileBrowser.tsx`
and `FileEditor.tsx` *components* are reasonably covered (83% / 78% line), which masks
the fact that the **hook logic underneath them is not**.

## Evidence

- `coverage/clover.xml` → `useSessionFileSystem.ts` conditionals 61/covered 5 (8%),
  lines 33%; `useFileSystem.ts` 73/covered 27 (37%); `useLocalFileSystem.ts` 46/covered
  17 (37%).

## Recommendation

Add hook-level tests (via `@testing-library/react`'s `renderHook`) that drive each
operation's success **and** failure branches with a mocked `api`: permission denied,
missing path, remote error, sudo-required, external-change/conflict. Assert the hook
surfaces the error (no silent swallow) and does not perform a partial/destructive
write on the failure path. Prioritise `useSessionFileSystem` (remote, destructive).
