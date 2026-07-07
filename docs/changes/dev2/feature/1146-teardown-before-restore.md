### Fixed

- Launching a saved workspace or restoring the last session now closes the
  currently-open live sessions before placing the new layout. Previously the old
  tabs were dropped from the store while their backend PTY/SSH/agent sessions
  kept running, leaving them orphaned in the Open Connections panel with no tab
  to reach them. Persistent sessions are detached (their background process
  survives and can be re-adopted) rather than force-closed. Addresses GAP G1 of
  the workspace save/restore audit (#1146).
