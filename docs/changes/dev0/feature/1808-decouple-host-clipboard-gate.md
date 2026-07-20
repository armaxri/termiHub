### Added

- RDP: a new **Paste Local Files into Remote** option (`pasteLocalFiles`) lets
  files you copy on this computer be pasted into the remote session. It is
  independent of drive redirection — copied files are served from their real
  host paths, so no shared folder is required. Off by default; view-only
  suppression and the existing serve bounds (8 MiB chunking; the remote only
  selects advertised files) still apply. The mid-session re-advertise watcher
  (#1794) now starts under this opt-in rather than the shared-folder opt-in, so
  host-clipboard file sharing works on its own (#1808).
