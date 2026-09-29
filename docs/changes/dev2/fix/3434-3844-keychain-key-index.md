### Fixed

- With the OS keychain as credential store, the encrypted credential export now includes
  every saved secret — also the file editor's elevated-save (sudo) passwords and the
  passwords of VNC/RDP connections run through an agent — instead of only the ones tied to
  a saved connection.
- Switching the credential store away from the OS keychain now moves (or, when switching
  to "None", deletes) every saved secret, including per-connection passwords, key
  passphrases and sudo passwords that were previously left behind in the keychain.
- To find credentials saved by earlier versions, termiHub checks the OS keychain only when
  you export credentials or switch the credential store, never at startup, so a keychain
  access prompt can appear only during those two actions.
