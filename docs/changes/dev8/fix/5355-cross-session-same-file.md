### Fixed

- File browser: pasting a file onto its own path through a **different**
  session that reaches the same files (two local sessions on one agent host,
  two SSH sessions to one server as the same user, two sessions on one
  container) no longer empties it. The paste is refused with "source and
  destination are the same file", and a folder pasted into its own subtree that
  way is refused before anything is created. Copies between different hosts are
  unaffected (#5355).
