### Fixed

- A local session on a Windows agent host no longer offers Permissions, Owner
  and New symlink in the file browser, which only failed with an error there.
  The same goes for the file panel of a remote desktop routed through a Windows
  agent. This needs an agent with protocol 0.29.0 or newer; with an older agent
  the actions show as before (#4601).
