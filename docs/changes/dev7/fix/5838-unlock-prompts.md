### Changed

- Credentials: the unlock dialog a connect opens now always has a Cancel. Its other way on
  reads "Type password instead", the reset link reads "Forgot master password?", and its
  confirmation says it deletes every saved password. The password field no longer repeats
  its label as a placeholder.
- Credentials: with credential storage off, the password and passphrase prompts show one
  line, "Passwords aren't saved. Turn on saving…", with a real link. The disabled checkbox
  is gone.
- Credentials: the key passphrase prompt names the key by its file name. Hover it for the
  full path.
- Telnet: the password prompt says termiHub answers the server's login prompt for you, so
  you do not type the password again in the terminal.
- Connections: a canceled connect now names the connection and says what to do next. After
  you cancel the unlock dialog, "Type password instead" connects again and asks for the
  password. After you cancel a password prompt, "Retry" starts the connect again.

### Fixed

- Credentials: ticking "Save password" in a connect-time password prompt before you chose
  where to keep passwords no longer opens the storage chooser on top of the prompt. The box
  just ticks. Once the connection succeeds, termiHub asks once where to keep it and saves
  it there. If you close that question, nothing is saved.
