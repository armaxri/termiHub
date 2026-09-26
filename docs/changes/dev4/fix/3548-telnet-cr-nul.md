### Fixed

- Telnet: in character mode, Enter is now sent as `CR NUL` instead of a bare `CR`, as RFC 854
  requires for a network virtual terminal (a `CR LF` pair is still sent unchanged). Strict
  telnet servers that held the line or misread the byte after a bare `CR` now receive a
  well-formed line ending; line mode keeps sending `CR LF` (#3548).
