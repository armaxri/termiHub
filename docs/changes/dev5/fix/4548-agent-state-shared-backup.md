### Fixed

- Remote agent: an unreadable (unparseable) `state.json` is now backed up as
  `state.json.bak`, `state.json.bak.1`, … like every other damaged store,
  instead of `state.json.corrupt-<n>`. If no backup can be written, the agent
  still refuses to overwrite the damaged file (#4548).
