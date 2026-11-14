### Security

- Releases: the key that signs in-app updates is now used only by a dedicated release job that
  runs no third-party build code, so a compromised build dependency can no longer reach it
  (#5761).
