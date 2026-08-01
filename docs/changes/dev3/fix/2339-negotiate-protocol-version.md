### Fixed

- The remote agent now **negotiates** the protocol version during `initialize`
  instead of always echoing its own. It returns the lower of the desktop's
  requested version and its own supported version (within a shared major),
  matching the negotiation contract in `docs/remote-protocol.md`. Previously the
  agent unconditionally reported its own version (e.g. `0.7.0`) even when the
  desktop requested an older one, so the protocol version shown for a connected
  agent could be wrong. Incompatible major versions are still rejected with
  `-32002 Version not supported` (#2339).
