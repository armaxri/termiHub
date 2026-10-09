### Fixed

- Data safety: plugin state, plugin settings and the plugin trust files are
  now flushed to disk before they replace the old file, and two saves at the
  same moment can no longer mix their contents (#4334).
- A damaged plugin state file no longer blocks the plugin list or uninstall.
  termiHub keeps a copy as `plugin-state.json.bak` and rebuilds the list from
  the installed plugins. Every plugin starts disabled, and native plugins must
  be trusted again before they load (#4334).
- Plugin settings and the plugin trust files written by a newer termiHub are
  never overwritten. A damaged copy is backed up (`<file>.bak`, `<file>.bak.1`,
  …) before it is replaced (#4334).
- Remote agent: a damaged `connections.json`, or a `state.json` with a damaged
  entry, is now backed up as `<file>.bak`, `<file>.bak.1`, … instead of
  `<file>.corrupt-<timestamp>`, the same naming the desktop uses (#4334).
