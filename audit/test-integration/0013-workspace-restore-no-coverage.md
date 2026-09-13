---
id: TIN-013
title: Workspace / session-layout save-restore has no described automated or manual test coverage
angle: test-integration
severity: medium
category: test-gap
is_workaround: false
subsystem: src-tauri/src/workspace, src/store/appStore.ts
evidence:
  - src-tauri/src/workspace/
  - docs/testing.md
  - tests/system/tests/
status: open
---

## What

The app has a workspace subsystem (`src-tauri/src/workspace/` — `config.rs`,
`manager.rs`, `storage.rs`) that saves and restores session/tab-group layouts,
including multi-window layouts (#1925). An audit of `docs/testing.md` found **no
coverage described for it at all** — every "workspace" hit refers to Docker
`/workspace` mounts or VS Code workspaces, not session/layout restore. There is
no `test_workspace*.py` in the bridge suite. The closest adjacent coverage is
`test_config_recovery.py` (corrupt-config startup recovery) and split-view
scrollback survival (#2561), which are different features.

## Why it matters

- Workspace restore is a stateful, cross-restart, potentially multi-window
  feature — a high-integration-risk area where a regression (tabs lost, wrong
  layout, a restore-spawned window not hydrating) directly loses user work.
- It sits at the junction of the backend store, appStore projections, and window
  spawning — precisely the kind of seam the stateless-UI/projection migration
  churned, and precisely what an integration test should guard.
- A feature with zero coverage that is neither automated nor on the manual matrix
  is invisible to the whole test story.

## Evidence

- `src-tauri/src/workspace/` exists; `appStore.ts:1734-1795` — "Capture the full
  multi-window layout for persistence (#1925)", restore/hydrate secondary windows.
- No `test_workspace*` suite in `tests/system/tests/`; `docs/testing.md` manual
  matrix has no workspace-restore entry.

## Recommendation

- Add a bridge integration test: build a multi-tab (and, once the harness is
  multi-window aware — TIN-014, single-window) layout, save the workspace,
  restart the app (`SystemTest.restart_app` supports this), and assert the layout
  is restored faithfully.
- At minimum add a backend integration test over `workspace::manager`/`storage`
  (save → reload → structural equality) so the persistence format is guarded even
  before the UI journey is automated.
- Add a manual-matrix entry as an interim release gate until automated.
