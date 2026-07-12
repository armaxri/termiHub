### Added

- FTP / FTPS connection type: a new **FTP** backend is registered in the desktop
  connection registry, so an FTP connection can be created and configured in the
  connection editor. The schema-driven editor exposes Server (host, port),
  Security (TLS mode: none / explicit STARTTLS / implicit), Authentication
  (anonymous toggle with conditional username / password), and Transfer (passive
  or active mode, binary or ASCII, initial directory, timeout) groups. Connecting
  establishes the control channel — TCP, optional TLS negotiation, USER/PASS or
  anonymous login, passive/active selection, transfer type, and an initial `CWD`
  — over rustls (aligned with termiHub's TLS stack). File listing and transfers
  are not implemented yet; they land in follow-up steps of the FTP client epic
  (#1331). (#1332, epic #1331, concept #518)
