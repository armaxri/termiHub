### Added

- **Untrusted X11 forwarding for SSH connections.** A new "Untrusted X11
  forwarding" option (under X11 forwarding in the connection's Advanced
  settings) works like OpenSSH's `ssh -X`: remote programs get a restricted,
  short-lived key for your display instead of full access, so they cannot read
  other windows or watch what you type. New remote windows can open for 20
  minutes after connecting. It needs a local X server with the SECURITY
  extension; with XQuartz (macOS) or VcXsrv (Windows), which lack it, the
  connection opens without X11 forwarding and says why. The option is off by
  default, so X11 forwarding keeps working as before (#5585).
