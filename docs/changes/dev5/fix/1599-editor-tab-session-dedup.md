### Fixed

- Editor tabs: opening the same file path from two different remote sessions no
  longer collapses into a single tab that silently re-points at the second
  session. Previously editing `/etc/hosts` on SSH host A and then on host B (or
  the same path across an FTP host and a Docker container) reused one tab and
  jumped its content and save target to the second session, risking a save to
  the wrong host. Editor-tab deduplication now includes the backing session's
  stable identity (SFTP `hostLabel`, or the owning terminal tab for session-layer
  browsers), so different sessions get independent tabs while reconnecting the
  same connection still refreshes the existing tab in place rather than
  duplicating it (#1599).
