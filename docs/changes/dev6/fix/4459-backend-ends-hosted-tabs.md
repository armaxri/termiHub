### Fixed

- Agents: disconnecting or shutting down a remote agent now ends its open terminal tabs in the
  backend, once for every window, before the windows hear about it. A tab ended this way can no
  longer start reconnecting afterwards, even when its session closes a moment later, so it stays
  on the "Agent disconnected" banner with a manual Reconnect instead of trying a reconnect that
  cannot succeed. Tabs that had already ended keep their state, and an agent update or Force
  reconnect still keeps the tabs resumable (#4459).
