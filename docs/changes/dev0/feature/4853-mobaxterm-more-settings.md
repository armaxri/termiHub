### Changed

- **MobaXterm import carries over more settings** (#4853): a VNC session behind a
  single MobaXterm SSH gateway now imports with termiHub's VNC SSH tunnel turned on
  (gateway host, port, user and key file). Settings termiHub has no counterpart for
  stay listed in the preview, now with their values so you can recreate them by
  hand: the SSH command run at login, an SSH or VNC network proxy (type, host and
  port), the SSH gateway or Remote Desktop Gateway of an RDP session, and a VNC
  gateway chain of more than one host.
