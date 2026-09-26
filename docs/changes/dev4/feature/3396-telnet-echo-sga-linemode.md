### Added

- Telnet **Input Mode** setting: _Character_ (default) sends every keystroke
  immediately; _Line_ edits and echoes the line locally and sends it on Enter,
  for line-oriented devices that never echo (PROD-025, #3396).

### Fixed

- Telnet now accepts the server's ECHO and SUPPRESS-GO-AHEAD options instead of
  declining them, so servers that offer them echo input correctly (no double
  echo or missing echo), and outgoing `0xFF` bytes are escaped as the telnet
  protocol requires (PROD-025, #3396).
