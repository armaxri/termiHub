### Added

- VNC: a direct connection (no SSH tunnel, no agent) can now link a saved SSH connection as its
  file route under **File Transfer → File transfer via**. Drop-to-upload, **Upload files…** and
  **Browse remote files** then run over SFTP on that connection's own SSH session, with its saved
  password or key, its jump hosts and the usual host-key check. The picker preselects an SSH
  connection on the VNC host and warns when the hosts differ; every label names the host the
  files actually land on. A deleted link turns file transfer off again instead of failing
  (#4194, concept #3770).
