### Fixed

- Embedded-server configuration (`embedded_servers.json`) is now saved atomically
  (temp-file + `sync_all` + rename), matching the protection already applied to the
  other config stores. An interrupted save — from a crash, power loss, or full disk —
  can no longer truncate the file and silently wipe your configured HTTP/FTP/TFTP
  servers; the file always holds either the complete previous or complete new
  contents (#2327).
