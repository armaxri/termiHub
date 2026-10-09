### Fixed

- RDP: the bundled RDP helper is now built with integer overflow checks, like
  every other shipped termiHub binary, so a malformed value from an RDP server
  stops the session cleanly instead of being silently corrupted. File times far
  in the future on a redirected drive are now reported as the latest
  representable time instead of a garbage value.
