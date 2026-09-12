### Fixed

- Running embedded HTTP/FTP/TFTP servers now appear in the **Open Connections**
  panel. The panel is meant to be the one place to inspect and stop every live
  subsystem, but embedded servers were missing, so a running server could not be
  seen or stopped from there. A new **Embedded Servers** section lists each live
  server (name, protocol, bind address, and port) with a per-row **Stop** and a
  **Stop All**, reusing the Services sidebar's state and stop action. The section
  is hidden when no embedded server is running (SM-017).
