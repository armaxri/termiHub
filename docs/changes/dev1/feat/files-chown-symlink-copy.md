### Added

- The file browser can now **change ownership (chown)**, **create symbolic
  links**, and **copy** files/directories within a backend. Each is offered only
  where the backend supports it — a local Unix host or an SFTP-backed (SSH)
  session — and appears in the right-click / actions menu next to Change
  Permissions:
  - **Change Owner** opens a small dialog with numeric uid/gid fields; leaving a
    field blank keeps that side unchanged.
  - **Create Symlink** creates a link in the current directory pointing at the
    selected entry.
  - Copy/paste now uses a native same-backend copy where available (recursive for
    directories, preserving nested symlinks).

  Backends that cannot perform an operation (FTP, Docker, WSL, or a non-Unix
  local host) report it honestly — the action is hidden and the underlying call
  returns a typed "not supported" error rather than silently doing nothing. This
  mirrors the existing chmod support across every layer (core capability, the
  agent JSON-RPC path, the desktop commands, and the UI). Cross-backend /
  remote↔remote copy is unchanged and still handled by the transfer queue
  (PROD-0013).
