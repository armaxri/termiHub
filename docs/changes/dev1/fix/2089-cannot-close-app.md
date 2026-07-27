### Fixed

- The application can be closed and quit again. The close-window flow (#1903)
  prevents the OS default close and calls `getCurrentWindow().destroy()` from
  the frontend, but the window capability never granted
  `core:window:allow-destroy`, so Tauri's ACL silently denied every destroy —
  the confirm dialog would appear once and no close attempt could ever actually
  close the window, forcing a force-kill. The default capability now grants
  window destroy/close and applies to both the primary `main` window and the
  secondary `win-N` windows (#2089).
