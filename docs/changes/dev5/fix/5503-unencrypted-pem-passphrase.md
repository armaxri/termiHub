### Fixed

- SSH: a saved passphrase on an unencrypted PKCS#8 (`BEGIN PRIVATE KEY`) or EC
  (`BEGIN EC PRIVATE KEY`) key no longer breaks the connection. As with OpenSSH,
  a passphrase for an unencrypted key is now ignored for every key format
  (#5503).
