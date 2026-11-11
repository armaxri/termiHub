### Added

- **RDP follows server redirection** (#5137): an RDP server behind a
  connection broker or load balancer (a Windows RDS farm) no longer ends the
  session with "termiHub does not follow RDP server redirections yet".
  termiHub reconnects to the server the redirection names (and into the
  session it names), sends the broker's routing token, and uses the
  username, domain and password cookie the broker hands over, or else the
  saved credentials. It follows up to three redirections.
- **A redirect target's certificate is checked before anything is sent to
  it**: termiHub reads the new server's certificate first and asks you about
  an unknown or changed one exactly as on a first connect, under that
  server's own name. Trusting the broker never trusts the servers behind it.

### Changed

- A redirect loop, a fourth redirect, or a redirect on a connection that runs
  through an SSH tunnel, proxy or agent ends the session with a message that
  names the server, and is not auto-reconnected.
