### Fixed

- RDP (experimental): on Windows the `termihub-rdp-helper` sidecar no longer
  flashes a console window each time an RDP session is opened. It is spawned with
  `CREATE_NO_WINDOW`; stderr logging is unaffected.

### Security

- RDP (experimental): the sidecar no longer silently accepts any server
  certificate. When "Ignore Certificate Errors" is off (the default), an
  untrusted server certificate now refuses the connection with an actionable
  message that names the server public-key fingerprint, instead of connecting
  unverified. Enable "Ignore Certificate Errors" in the connection's RDP options
  to trust a specific host. An interactive accept-once / accept-for-host prompt
  with a persisted per-host trust store is a follow-up.
