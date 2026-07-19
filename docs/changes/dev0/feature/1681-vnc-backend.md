### Added

- VNC (RFB) remote-desktop connections. A new **VNC** connection type plugs into
  the shared graphical remote-desktop layer (#1680): it decodes the RFB
  framebuffer in Rust (Raw / ZRLE / CopyRect, plus server cursor shapes) into the
  shared canvas, translates keyboard/mouse/scroll input to RFB, and syncs the
  text clipboard both ways. The connection editor exposes VNC-specific options on
  top of the shared fields — a display number (the port becomes `5900 + display`),
  an encoding preference, show-remote-cursor, and an optional **SSH Tunnel** group
  that reaches the server through an SSH local forward — with no domain field.
  Classic VNC-password and no-auth servers are supported. Ships **experimental**:
  hidden unless experimental features are enabled (#1705). (#1681, epic #1678)
