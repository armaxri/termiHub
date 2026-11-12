### Changed

- UI: the connection settings that come from the backends (SSH, local shell, WSL, serial,
  telnet, Docker, FTP, VNC, RDP and the HTTP monitor) follow the copy style guide
  (`docs/copy-style.md`). Field labels, option names and group titles use sentence case, so
  an SSH connection's form now says "SSH key", "SSH agent", "Keyboard-interactive (OTP /
  2FA)", "Key path" and "Auto-reconnect", like the remote agent's form.
- UI: the remote desktop toolbar's scaling modes read "Fit to tab", "1:1 pixel" and "Match
  window", matching the connection editor.
