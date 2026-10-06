### Added

- VNC: a new **File Transfer** group in the VNC connection editor ("Allow file
  transfer over the side channel" plus a default folder), off by default. When
  enabled, files can move over the connection's own side channel — SFTP on the
  SSH tunnel's already-authenticated session (no second login), or the hosting
  agent's file service — never over RFB. Direct VNC connections and view-only
  sessions get no file transfer. This release adds the backend route resolution;
  drag-and-drop upload and browsing follow (#4191, concept #3770).
