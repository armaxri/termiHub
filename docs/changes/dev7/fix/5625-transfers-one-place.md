### Changed

- File browser: transfers are now listed in one place, the Transfers panel at the
  bottom of the window. The file sidebar no longer repeats the list under the
  file list; it shows a one-line summary (for example "2 transfers done") that
  opens the panel (#5625).
- Transfers panel: it collapses into the status-bar indicator a moment after
  every transfer has completed, and opens again when a new transfer starts.
  Failed or cancelled transfers keep it open. "Cancel all" only shows while
  something can be cancelled, the path column shows the destination folder with
  the full path on hover, finished rows offer "Remove from list" instead of a
  trash can, and file names use the interface font (#5625).
