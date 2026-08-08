### Changed

- Agent-hosted terminal sessions now reconnect **backend-driven** when the
  `sessionBackendReattach` flag is on (#2476). On a dropped agent transport the
  backend redrive re-establishes the connection, parks and retries for as long as
  the drop lasts, mints a fresh session, and the tab re-attaches to it — the
  client no longer runs its own agent reconnect engine in parallel (which would
  double-drive the transport). A backend give-up settles the tab as disconnected;
  the client per-attempt connect deadline no longer force-fails a prolonged
  backend-driven reconnect. The flag is default-off, so agent reconnect behavior
  is unchanged until it is enabled.
