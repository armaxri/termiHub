# Changes

## Added

- **Multi-window restore now recreates the saved window arrangement** (#1925,
  epic #1899). Saving a workspace or the last session with tabs spread across two
  or more windows, then restarting (or launching that workspace), now spawns each
  saved secondary window and hydrates it with its own tab groups — instead of
  collapsing every window's tabs into the main window. Empty secondary windows
  round-trip too. The main window aggregates every open window's layout when it
  saves, so the persisted document spans all windows even though each window is a
  separate JS context.

## Notes

- Single-window saves are unchanged and remain byte-identical to the legacy
  shape; the aggregation falls back to the current window if the cross-window
  commands are unavailable (e.g. browser dev mode).
