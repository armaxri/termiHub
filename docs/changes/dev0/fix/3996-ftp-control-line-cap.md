### Security

- Embedded FTP server: a client can no longer make the server buffer an
  unbounded control line. termiHub now fronts the FTP server with its own relay.
  A command line longer than 8 KiB gets `500 Command line too long.` and the
  connection is closed (#3996).

### Changed

- Embedded FTP server: passive data ports are now opened by termiHub's relay on
  demand, within the same 49152–65534 range. `EPSV` keeps working. The access
  log still shows each client's real IP address (#3996).
