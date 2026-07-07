# Changes — dev1/feature/1235-agent-cancellable-connect

## Added

- **Cancel a connecting remote agent.** A remote agent stuck mid-connect (e.g. to an
  unreachable or slow host) can now be cancelled instead of waiting out the connect timeout.
  The blocking SSH + initialize handshake is wrapped in a per-agent cancellation token; firing
  it aborts the handshake promptly and returns the agent to `disconnected`
  (via the new `cancel_connect_agent` backend command) (#1235).
- **Connecting and reconnecting agents are visible and killable in Open Connections.** The
  panel gained an **Establishing / recovering** section listing agents in the `connecting` or
  `reconnecting` state. Each row has a **Cancel** button: a connecting agent aborts its
  handshake; a reconnecting agent ends its backoff loop by disconnecting (#1235).
- **Sidebar Cancel for a connecting agent.** The agent header now shows an inline **Cancel**
  control (and a **Cancel Connect** context-menu item) while connecting, so a stuck connect is
  no longer a dead-end in the sidebar (#1235).
