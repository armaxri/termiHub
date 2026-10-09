---
id: LIBFE2-003
title: "Shared path helpers (getBasename, parentDirPath) under-used: six private baseName copies plus inline splits, with a Windows bug in the editor-tab path"
angle: lib-usage-frontend
severity: low
category: correctness
is_workaround: false
subsystem: "src (path handling)"
status: fixed
resolution: "#4372 — one shared src/utils/paths.ts (getBasename/parentDir/joinPath, drive and UNC roots); private copies and inline splits removed"
audit: 2026-10
commit: "663465d52"
relation: new
evidence:
  - src/utils/formatters.ts:184
  - src/utils/fileDragMove.ts:38
  - src/store/slices/tabOpenersSlice.ts:409
  - src/components/Sidebar/FileBrowser.tsx:916
  - src/App.tsx:409
  - src/components/Terminal/TerminalRegistry.tsx:388
  - src/hooks/transferFeedback.ts:17
  - src/components/RemoteDesktop/fileTransfer.ts:26
  - src/components/Plugins/PluginInstallDialog.tsx:48
  - src/components/Settings/BackupRestoreDialog.tsx:64
  - src/components/Settings/CredentialVaultImportDialog.tsx:51
  - src/utils/fileBrowserNav.ts:148
  - src/hooks/useLocalFileSystem.ts:146
  - src/hooks/useSessionFileSystem.ts:343
---

## What

`getBasename` (separator-aware, in formatters.ts) and `parentDirPath`/`joinDirPath` (drive-root-aware, in fileDragMove.ts) already exist. Even so, five components define their own `baseName`, and parent-directory logic is re-derived inline in at least six places, each with different edge cases. Two of these sites are POSIX-only on paths that can be native Windows paths.

1. `openEditorTab` titles the tab with `filePath.split("/").pop()` (tabOpenersSlice.ts:409). The "open saved terminal output" flow (TerminalRegistry.tsx:388 `save()` → App.tsx:409 `openEditorTab(path,false)`) passes a native `C:\Users\…\terminal.txt`, so the tab title becomes the whole path.
2. FileBrowser.tsx:916 computes the editor file's parent with `replace(/\/[^/]+$/, "")`. For a backslash path that returns the file path itself, and navigateLocal then tries to list a file. For `C:/x.txt` it returns bare `C:`, which on Windows means the drive's current directory, not its root.

## Why it matters

Every hand copy can drift on its own, and here the drift has produced user-visible Windows bugs (a wrong tab title, and the local pane navigating to a file or the wrong directory) in a code path that already has a correct shared helper. This is the same 'under-used existing helper' pattern as LIBFE-002, applied to paths.

## Recommendation

Make src/utils/formatters.ts `getBasename` the only basename (delete the five private `baseName` copies), and add `parentDir(path)` and `joinPath(dir, name)` to one shared module, reusing fileDragMove's backslash and drive-root logic. Route tabOpenersSlice.ts:409, FileBrowser.tsx:916, useLocalFileSystem.ts:146/187, useSessionFileSystem.ts:199/343 and fileBrowserNav.ts:148 through them. Do not use `@tauri-apps/api/path`: it is async, uses the local OS's rules, and cannot handle remote POSIX paths. Add tests for `C:\\a\\b.txt`, `C:/b.txt` and `/a`.

## Verification

Confirmed. tabOpenersSlice.ts:409 uses `filePath.split('/').pop()`, and FileBrowser.tsx:916 uses `replace(/\/[^\/]+$/, '')`. The 'save terminal output' flow passes the native path from the Tauri save() dialog straight to `openEditorTab(path, false)` (App.tsx:409), so on Windows that path has backslashes, the tab title is the full path, and the local pane tries to navigate to the file. These are real Windows-only bugs with low impact.
