### Fixed

- Launching a workspace in two desktop windows no longer risks corrupting
  layout or session mapping. Panels created during workspace launch previously
  drew their ids from a per-window counter (`ws-panel-1`, `ws-panel-2`, …), so
  two windows produced the same ids and a cross-window operation could target
  the wrong window's panel. Workspace panel ids are now globally unique by
  construction.
