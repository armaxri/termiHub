### Fixed

- On macOS, saving a password no longer fails when the keychain already holds
  an item for that connection that the current termiHub build may not read.
  Every update of the unsigned beta is signed differently, and macOS ties a
  keychain item to the build that saved it, so after an update a saved secret
  can only be read through an access prompt. If you decline the prompt, or the
  item came from an earlier build, saving the secret again now replaces that
  item instead of asking you to delete it in Keychain Access. A saved secret
  that cannot be read now says how to recover: allow access when macOS asks,
  or enter the secret again and save it.
