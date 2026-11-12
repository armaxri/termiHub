### Fixed

- Remote desktop (RDP/VNC): a refused, unreachable or unresolvable host now
  shows "Connection refused", "Host unreachable" or "Host not found" with the
  same hint as a terminal tab, and a timeout shows "Timed out", instead of a
  generic "Connection failed". The OS-level detail sits behind "Details"
  (#5380).
