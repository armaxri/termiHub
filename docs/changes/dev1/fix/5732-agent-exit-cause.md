### Fixed

- A Telnet or SSH session running on a termiHub remote agent whose server closes the connection
  now ends the tab with "— connection closed by server —", like a direct session, instead of
  leaving the tab open or reading "connection lost". Losing the agent link itself still reads
  "connection lost". Needs an updated agent (protocol 0.38.0); with an older agent the session
  behaves as before (#5732).
