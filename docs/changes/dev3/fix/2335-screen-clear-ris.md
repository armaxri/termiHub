### Fixed

- Clean-startup output buffering now recognizes the RIS full-reset sequence
  (`ESC c`) as a screen clear. Previously only `CSI 2 J` / `CSI 3 J` were
  detected, so a connection with an initial command and "wait for screen clear"
  enabled would hang for the full 5-second timeout — then dump the raw startup
  banner — whenever the program or device cleared the screen via RIS (common on
  serial/telnet embedded-device menus and emitted by `reset` / `tput reset`).
