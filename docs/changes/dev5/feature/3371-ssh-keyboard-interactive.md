### Added

- SSH connections now support **keyboard-interactive** authentication — one-time
  codes, 2FA and PAM challenge prompts — answered in a new in-app **SSH
  Authentication** dialog that shows the server's instructions and masks secret
  prompts. Pick **Keyboard-Interactive (OTP / 2FA)** as the method, or keep
  **Password** / **SSH Key**: termiHub continues with the interactive prompt
  automatically when the server asks for a second factor or refuses plain
  password auth. A saved password answers a lone "Password:" prompt for you;
  one-time codes are always asked. Works for direct connections, every jump-host
  hop and Test Connection; time spent typing a code does not count against the
  connect timeout, and cancelling the dialog stops the connect without an
  "Authentication failed" error (#3371, PARITY-010).
