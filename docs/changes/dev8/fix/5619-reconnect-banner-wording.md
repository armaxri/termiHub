### Fixed

- The reconnect strip now says what dropped: an unplugged serial device reads
  "Device disconnected — waiting for <port> to come back", a closed telnet
  connection reads "Connection closed", and an SSH tab says its remote shell
  restarts instead of talking about "an agent". The strip and the disconnect
  overlay use the app's UI font instead of the terminal's monospace font
  (#5619).
- A dropped connection or unplugged device no longer writes "[Process exited]"
  into the scrollback. It writes "— connection lost hh:mm:ss —" or
  "— device disconnected hh:mm:ss —". Real process exits still show
  "[Process exited]" (#5619).
- The disconnect overlay says the scrollback is kept and points to View
  scrollback, instead of "Scrollback is preserved below". Its dismiss button
  now sits on the overlay card and has a "Dismiss" tooltip (#5666).

### Added

- After a reconnect, the terminal writes "— reconnected hh:mm:ss —" between the
  old scrollback and the new session's output (#5660).
