### Added

- The remote agent can now host **FTP / FTPS** connections. The agent's
  connection registry registers the FTP backend (gated behind the default-on
  `ftp` feature), bringing it to parity with the desktop for this type, so an
  agent-hosted connection set is no longer a strict subset of the desktop's
  (PARITY-003). Graphical remote-desktop types (VNC / RDP / the mock backend)
  remain desktop-only — the agent has no graphical/frame session transport yet.
