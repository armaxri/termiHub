### Fixed

- Serial connections now accept a `baudRate`/`dataBits`/`stopBits` given as a
  JSON number (the canonical wire form used by stored connection definitions,
  agent-forwarded configs, and the remote protocol) instead of silently
  dropping it back to a default. Previously the connect path read these fields
  as strings only, so a numeric value failed extraction and quietly opened the
  port at the default framing — bypassing the validation added in #2349. A
  present-but-malformed value (a non-numeric string, a boolean, or an
  out-of-range number) is now rejected with a clear configuration error rather
  than defaulted. Values chosen through the connection editor are unaffected.
