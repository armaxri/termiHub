### Added

- Remote agents now surface their **version and update state** across the UI
  (#1347). Each agent shows a monospace version chip (e.g. `v0.1.0`) plus an
  update-state badge — up-to-date, update available, incompatible, or updating —
  in the connections sidebar header and (with a text label) in the Open
  Connections panel. The status bar gains a connected-agents summary showing
  `N agents` and `· M updates available` when any connected agent's version is
  older than the desktop's; clicking it opens the Connections sidebar. The state
  is derived from the agent's reported version against the desktop version using
  the same major/minor compatibility rule as agent deployment. This is
  visibility only — no update is triggered yet.
