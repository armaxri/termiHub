### Fixed

- Portable mode: caches, web view data and temporary files now stay in the portable folder.
  Downloaded agent binaries, plugin downloads and drag-out staging go to `data/cache/`, the
  web view's data to `data/webview/` (Windows, Linux), and temporary files to `data/tmp/`,
  which is emptied at start and exit. On macOS, where the web view's data folder cannot be
  moved, a portable copy keeps web view data in memory only. Previously these were written to
  the host user's profile (#5764).
