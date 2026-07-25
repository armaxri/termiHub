### Added

- Multi-window: closing a window that still owns live sessions now presents a
  detach-vs-terminate decision instead of silently killing sessions (#1903,
  epic #1899). Persistent/agent sessions detach (the backend process keeps
  running and can be re-attached later); non-persistent sessions (local shell,
  serial, one-shot SSH) would be terminated. The dialog's primary action moves
  the live tabs to another window (safe — nothing is lost), the red action ends
  the sessions, and Cancel keeps the window open. A window whose sessions are
  all persistent detaches them with just a toast (no dialog), and an empty
  window closes with no prompt.

### Changed

- Multi-window: the last window closing now follows a per-OS quit policy. On
  macOS the app stays alive in the Dock when its last window closes (WKWebView
  convention) and recreates a window when the Dock icon is clicked; on
  Windows/Linux closing the last window quits the app. A non-last window close
  never quits the app (#1903).
