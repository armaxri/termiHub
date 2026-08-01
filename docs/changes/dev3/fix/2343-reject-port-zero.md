### Fixed

- Port Scanner now rejects port `0` with a clear validation error instead of
  silently probing it. Port 0 is IANA-reserved and can never host a listening
  TCP service, so `"0"` or a range like `"0-100"` now returns a "port must be
  between 1 and 65535" error rather than issuing a meaningless probe (#2343).
