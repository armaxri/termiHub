# Changes

## Fixed

- **Windows registry daemon**: a second registry daemon that loses the bind race
  for an already-owned named pipe now exits cleanly (deferring to the running
  winner) instead of failing with a hard error. The Windows named-pipe transport
  now maps `first_pipe_instance`'s `ERROR_ACCESS_DENIED` to `AddrInUse`, matching
  the Unix domain-socket contract the registry daemon relies on.

## Testing

- The `registry_daemon_integration` suite no longer gates on `#![cfg(unix)]`, so
  the registry daemon's cross-process behaviour (register/broadcast/deregister,
  auto-spawn, bind-race, coordinated-update) is now proven on the Windows
  named-pipe endpoint in CI, not only on the Unix domain socket.
