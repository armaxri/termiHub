### Fixed

- Config persistence is now hardened against torn writes on crash, power loss, or
  a full disk. Connections (`connections.json` and external connection files),
  application settings (`settings.json`), saved Wake-on-LAN devices
  (`wol-devices.json`), and HTTP monitor configs (`http-monitors.json`) all now
  save via an atomic temp-file + `sync_all` + rename, so an interrupted save can
  never truncate the existing file and silently wipe your saved data — the file
  always holds either the complete previous contents or the complete new
  contents. Extends the same protection already applied to workspace persistence
  (#2318) to every remaining config store (#2320).
