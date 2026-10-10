### Fixed

- Closing a local shell, WSL or telnet tab whose program stopped reading its
  input (or whose telnet peer stopped reading) now ends the shell process or
  closes the socket at once. Before, they lingered after the tab was gone until
  the stuck write returned, which for a shell could be never. Telnet writes
  also give up after 30 seconds without progress (#4394).
