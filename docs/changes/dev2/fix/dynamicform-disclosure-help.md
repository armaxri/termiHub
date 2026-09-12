### Added

- SSH connection forms now hide advanced options behind a collapsible
  **Advanced** section that starts closed, so a basic key- or password-auth
  connection shows just the essentials (host, port, username, auth method)
  instead of every option at once. Click the section header to reveal the
  advanced settings; the expander is keyboard-accessible and none of the
  advanced values or validation are lost while it is collapsed (UX-008).

### Changed

- Every connection settings field can now surface its extended help: the "?"
  help button that opens a details dialog appears on all field types, not only
  toggles. Guidance authored for fields like SSH's Connect Timeout, Environment
  Variables, and On-reconnect Command is now reachable (UX-009).

### Fixed

- Fixed a connection editor bug where, after switching a connection's type, the
  very next edit to a field could be silently discarded — Save then stored the
  old value. Field edits now always take effect (FEC-019).
