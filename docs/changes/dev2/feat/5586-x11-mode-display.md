### Added

- **Open connections shows how an SSH session's X11 forwarding runs.** An SSH
  session with X11 forwarding on gets a small chip on its row: "X11" when the
  SSH server forwards X11, "X11 fallback" with a warning icon when the server
  refused or did not answer the request and `DISPLAY` is set by the hidden
  typed setup, and "X11 failed" when it could not be set up. Hover or focus
  the chip for why, and for the fallback the server fix (`X11Forwarding yes`
  in its `sshd_config`) (#5586).
