### Fixed

- VNC: a server can no longer crash the VNC session with malformed or unusual
  protocol data. A `SetColorMapEntries` message is now ignored instead of
  panicking the client, and unsupported pixel formats or encodings, oversize or
  out-of-range rectangles, bad palette indexes and overlong run lengths now end
  the session cleanly with a protocol error (or are skipped, for cursor shapes)
  rather than panicking or attempting multi-gigabyte allocations. As a last line
  of defence, a panic inside the VNC driver is now contained and reported as a
  normal disconnect.
