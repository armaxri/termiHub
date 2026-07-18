### Fixed

- Agent: a notification the remote agent emits during the `initialize` handshake
  (before it answers `initialize`) is no longer silently dropped. The desktop
  connect path skipped every pre-initialize message while scanning for the init
  response, so an on-attach notice such as a staged `agent.update_available`
  never reached the frontend. Such notifications are now buffered during the
  handshake and replayed once initialize completes, on both the initial connect
  and the reconnect paths (#1660).
