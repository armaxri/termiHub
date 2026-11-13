### Added

- **Why X11 is off, on the open session.** The X11 chip on an SSH session in
  Open connections now says exactly why X11 forwarding is not active or fell
  back (no local X server, the server refused or did not answer, untrusted
  forwarding needs the SECURITY extension or xauth, or the fallback could not
  start), with a one-line fix, after the connect status is gone (#5601).
