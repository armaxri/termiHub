### Changed

- RDP certificate-trust prompt: the dialog now shows the server certificate's
  **subject** and **issuer** distinguished names alongside the host and SHA-256
  public-key fingerprint. The sidecar parses the DER server certificate returned
  by the TLS upgrade to populate them best-effort; a malformed or empty
  certificate still prompts (with the fields blank) rather than failing the
  connect (#1783).
