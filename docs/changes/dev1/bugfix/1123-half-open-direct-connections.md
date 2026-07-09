### Fixed

- Half-open direct connections no longer hang in "Connected" forever. When a
  telnet peer vanishes silently (cable pull, NAT timeout, crashed host) with no
  TCP FIN/RST, the socket now has TCP keepalive enabled, so the OS tears down
  the dead connection, the terminal shows the disconnect overlay, and the tab
  leaves the Connected state instead of freezing indefinitely (#1123).
