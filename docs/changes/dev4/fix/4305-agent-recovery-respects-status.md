### Fixed

- When a remote agent's connection drops and comes back, a tab you stopped
  during the drop now stays stopped. Before, it could be relabelled "Session
  lost" or "Reconnect failed", and a tab that had already ended could start
  reconnecting again on the next drop and even come back to life.
- Disconnecting or shutting down a remote agent now ends its tabs cleanly in
  every window, not only in the window where you clicked. Updating the agent
  and Force reconnect still keep the tabs ready to resume.
