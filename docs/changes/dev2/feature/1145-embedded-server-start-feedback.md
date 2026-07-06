### Fixed

- Embedded servers (HTTP/FTP/TFTP): starting or stopping a server that fails
  (for example a port already in use) now surfaces a clear error toast with the
  backend message instead of silently doing nothing. The Start/Stop action
  button is also disabled while the action is in flight so it cannot be
  double-triggered. (#1145)
