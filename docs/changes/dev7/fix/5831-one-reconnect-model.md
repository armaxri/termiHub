### Fixed

- Terminal: every disconnect notice now says why the session ended — the server closed
  the connection, the network was lost, the connection timed out, the device was
  disconnected, you disconnected, or the process exited with its code. Telnet no longer
  says "The connection was lost" when the server closed it (#5831).
- Terminal: the disconnect notice no longer covers the scrollback with a dark scrim; it sits
  at the top of the pane and the last lines stay readable and selectable (#5831).
- Terminal: when a dropped SSH, telnet or serial connection is not reconnected automatically,
  the notice says auto-reconnect is off for that connection and where to turn it on (#5831).
- Terminal: after a reconnect, the scrollback marker says a new remote shell started and
  running programs were lost (#5831).
- Terminal: the reconnect strip offers "Retry now", says what happens after the last attempt,
  and shows a serial device by its short name with the full path in a tooltip, as the
  status-bar chip now does too (#5831).
