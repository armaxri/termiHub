### Changed

- **Cancelling a connection while it is still connecting now works on every
  connection type, not just SSH.** Previously only SSH honoured "Cancel
  connect" promptly — for Docker, FTP, telnet, VNC, RDP, local, serial and WSL
  the cancel button did nothing until the underlying operation returned or hit
  its timeout (e.g. a slow Docker image pull or an unreachable FTP/VNC/RDP host
  could hang for the full connect timeout). Cancel now aborts the in-flight
  connect right away and reports the same "Connection cancelled" result across
  all backends. For Docker, cancelling part-way through the pull → create →
  start flow also tears down any container that was already created, so a
  cancelled connect leaves nothing running on the host. The behaviour of a
  connect that is _not_ cancelled is unchanged (PARITY-007).
