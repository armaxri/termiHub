### Fixed

- VNC VeNCrypt over TLS (X509) now connects to real servers. The VeNCrypt
  handshake was missing the server's post-sub-type acknowledgement byte that
  every real server (TigerVNC and the wider VeNCrypt 0.2 ecosystem) sends before
  the TLS handshake begins; the client mistook it for the first TLS record byte
  and aborted with a "corrupt message" error, so no VeNCrypt X509 server could be
  reached. The byte is now consumed, and a new integration test against a real
  TigerVNC X509 server proves the negotiate → TLS → VNC-password → decode path
  end to end for both `tlsVerify=insecure` and `tlsVerify=ca` (#1714/#1770).
