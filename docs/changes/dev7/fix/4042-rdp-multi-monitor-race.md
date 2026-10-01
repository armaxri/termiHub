### Fixed

- RDP: a session no longer drops at random when a local action (input, resize or a
  monitor-layout change) reaches the RDP helper while the server is sending screen
  updates. The helper could lose part of the half-read message, misread every message
  after it and end the session (#4042).
