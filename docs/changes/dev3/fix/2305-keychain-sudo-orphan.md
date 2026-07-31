### Security

- OS keychain credential store: deleting a connection now also removes its
  stored **sudo password** from the native OS credential store (macOS Keychain,
  Windows Credential Manager, Linux Secret Service). Previously only the password
  and key passphrase were removed, leaving the sudo password orphaned in the OS
  store with no way to clean it up from the app (#2305).
