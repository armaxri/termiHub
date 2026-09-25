### Changed

- Connections: automatic reconnect is now one setting, **Auto-Reconnect**, shared by every
  connection type that supports it (SSH, VNC, RDP), and it is **on by default**. SSH's
  former "Resilient Reconnect" setting (off by default) is renamed; an SSH connection that
  never set it now auto-reconnects after a dropped link, while an explicit on/off choice is
  kept. Existing saved connections are migrated automatically and `connections.json` moves
  to schema version 4. Connections stored on a remote agent, external connection files and
  imports that still carry the old setting are read correctly (#3359).

### Fixed

- Connection editor: a field shown only while a default-on toggle is enabled (such as the
  SSH on-reconnect command) is now visible for a connection saved without that toggle
  (#3359).
