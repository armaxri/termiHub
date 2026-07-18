### Changed

- Editor tabs: when two or more editor tabs share the same file basename but
  are backed by different remote sessions, the tab title now appends a session
  qualifier so they are distinguishable — e.g. two `hosts` tabs on different
  SSH hosts show as `hosts — user@host-a` and `hosts — user@host-b`. For
  SFTP-backed tabs the qualifier is the host label; for session-layer tabs it is
  the title of the owning terminal tab. A lone editor tab, a local file, and any
  case with no basename clash keep their plain basename (#1640).
