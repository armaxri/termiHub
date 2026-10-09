### Fixed

- Remote agent: one stuck session no longer freezes the agent. Re-attaching a persistent
  session or loading its scrollback used to block every other session on that agent (typing,
  resizing, opening, closing and listing sessions) for as long as that session's daemon took
  to answer, up to a minute or more after a reconnect. Other sessions now keep working, and
  input to the re-attaching session waits for it and arrives in order (#4286).
