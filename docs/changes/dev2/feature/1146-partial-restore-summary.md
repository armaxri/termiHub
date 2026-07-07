### Added

- After restoring the last session or launching a saved workspace, termiHub now
  shows a single summary toast once every restored tab has finished connecting.
  A fully successful restore reports "Restored N tabs"; a partial restore reports
  "Restored N of M tabs — K could not reconnect". Previously each tab that failed
  to reconnect was only visible by clicking into that individual tab, with no
  overview of how many tabs came back. Addresses GAP G4 of the workspace
  save/restore audit (#1146).
