### Added

- VNC connections now negotiate **VeNCrypt** (RFB security type 19) with TLS
  encryption when the server offers it, falling back to classic VNC-password /
  no-auth otherwise. The X509 sub-types (`X509None`/`X509Vnc`/`X509Plain`) run
  over a rustls TLS channel, and the plaintext `Plain` sub-type is supported for
  legacy servers. A new **TLS Certificate Verification** option chooses between
  the system trust store (default), accepting a self-signed certificate, or a
  custom PEM CA bundle; the shared Username field feeds the VeNCrypt `Plain`
  sub-authentication.
