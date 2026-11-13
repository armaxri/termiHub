### Fixed

- A telnet tab now shows the disconnect overlay with Reconnect when the server
  closes the connection, resets it or stops answering keepalives, and when a
  write to the server fails. Before, the tab stayed green and "connected" while
  everything typed went nowhere (#5569).
