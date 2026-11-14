### Fixed

- An SSH tab whose remote shell exits now shows its real exit status,
  "[Process exited with code N]". A shell exited with a non-zero code is not reconnected, even
  with Auto-Reconnect on, and `exit` ends the tab cleanly. A lost connection, or a host going
  down, still reconnects. The same holds for an SSH session on an updated termiHub remote agent
  (#5801).
