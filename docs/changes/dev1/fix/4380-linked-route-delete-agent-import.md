### Fixed

- Connections: deleting an SSH connection that another connection (such as a VNC
  connection) uses as its linked file-transfer route now warns and names those
  connections, instead of silently leaving them with no file-transfer route (#4380).
- Import: the import summary now counts remote agents — added and already-present
  ones — so a file holding only agents no longer reports "Nothing imported" (#4380).
