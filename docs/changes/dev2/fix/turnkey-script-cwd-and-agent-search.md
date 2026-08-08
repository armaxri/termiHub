### Fixed

- Remote Agents sidebar search now matches an agent by its own name/label, not
  only by its saved connections. Typing a case-insensitive substring of an
  agent's label (e.g. `dev0` → "Dev Agent (dev0)") into the Remote Agents filter
  now surfaces that agent with its full tree and hides agents that match neither
  by name nor by a child connection; a "No agents match …" message shows when
  nothing matches (#2485).
