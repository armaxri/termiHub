### Added

- The file browser now offers two local-folder OS-integration actions that act
  on the currently-browsed folder: "open the OS file manager here" (worded per
  platform — Reveal in Finder / Show in File Explorer / Open in File Manager)
  and "open this folder as a VS Code workspace". Both appear as toolbar buttons
  and as folder-row context-menu items, and are shown only for local folders;
  the VS Code action additionally appears only when VS Code is detected. Opening
  a remote session's folder this way is intentionally out of scope (#2656).
