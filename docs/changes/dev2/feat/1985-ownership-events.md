### Fixed

- **Multi-window transfers**: a file transfer for a session owned by another
  window no longer briefly flashes in a non-owning window before being pruned.
  The backend now pushes `session → window` ownership changes (on claim,
  release, and window close) so every window updates its ownership mirror
  immediately, instead of only once a transfer-progress event happens to flow.
  (#1985)
