### Fixed

- Telnet: IAC command and subnegotiation sequences that a server splits across
  TCP read boundaries are now handled correctly. Previously the IAC filter was
  reset on every read, so a sequence straddling a chunk boundary leaked raw
  bytes into the terminal — a stray `0xFF`, a dropped negotiation with its
  option byte shown as garbage, or an entire subnegotiation payload. The filter
  is now a state machine whose parse state persists across reads, and it also
  properly consumes telnet subnegotiations (`IAC SB … IAC SE`) (#2331).
