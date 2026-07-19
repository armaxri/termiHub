### Security

- RDP now verifies the bundled `termihub-rdp-helper` sidecar against a SHA-256
  digest embedded at build time before spawning it, so a tampered, corrupted, or
  wrong-architecture helper fails the connection with an actionable error instead
  of being executed. The check is skipped for the `$TERMIHUB_RDP_HELPER` dev/test
  override and for local builds that do not bundle the sidecar (#1762).
