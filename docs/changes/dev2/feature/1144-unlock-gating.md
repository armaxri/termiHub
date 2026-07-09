### Fixed

- Credential store unlock gating is now unified and hardened across all connect
  paths (#1144). Connecting from the connection editor's "Save & Connect" now
  prompts to unlock a locked master-password store before using a saved
  credential, instead of silently falling back to an interactive password prompt
  (G3). All four connect paths (sidebar connection, agent, agent reconnect,
  connection editor) now share a single unlock gate that runs before credential
  resolution, so the unlock dialog is the primary trigger rather than an
  after-the-fact event (G2). Two connect actions hitting a locked store at the
  same time no longer wedge one of them forever — every unlock request now
  settles exactly once on any dialog exit, including wrong-password-then-dismiss
  (G1).
