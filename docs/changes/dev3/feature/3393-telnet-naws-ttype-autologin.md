### Added

- Telnet window-size negotiation (NAWS, RFC 1073): the terminal size is sent on
  connect and after every resize, so full-screen programs reflow with the window
  (PROD-027, #3393).
- Telnet terminal-type negotiation (RFC 1091) with a configurable **Terminal
  Type** (default `xterm-256color`) (PROD-025, #3393).
- Optional telnet auto-login: sends the username and password when the login and
  password prompts appear (configurable, case-insensitive prompts and timeout);
  stops and leaves the session interactive if a prompt does not appear or the
  login is rejected. The password is kept in the credential store, never in the
  connection file, and the field help warns that telnet sends it in cleartext
  (PROD-025, #3393).
