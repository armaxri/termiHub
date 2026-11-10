### Fixed

- Connecting a saved connection with a stored password or passphrase can now be
  aborted before its tab opens: the "Connecting…" notification shows the
  current connect stage and an **Abort** button. Abort cancels the connect in
  the backend, closes a session that still comes up afterwards, saves nothing
  and says "Connect canceled". When that connect fails for a reason other
  than a rejected credential (host down, VPN off, timeout), the tab opens on
  that failure with Retry instead of connecting a second time, so an
  unreachable host no longer makes you wait out the timeout twice (#5180).
