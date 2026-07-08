# Changelog fragment — feature/1237-agent-disconnect-vs-shutdown

## Added

- **Remote agents — separate Disconnect and Shutdown:** The connected agent
  header (and its right-click menu) now exposes two distinct teardown actions
  instead of one overloaded "Disconnect". **Disconnect (detach)** drops the
  connection but leaves persistent remote sessions running on the agent, so they
  reappear the next time you connect. **Shutdown (stop remote)** stops the remote
  sessions and disconnects, then reports how many sessions were stopped as a
  success toast. Tooltips distinguish the two: "Detach transport — keep
  persistent remote sessions" vs "Stop remote sessions and disconnect". (#1237)
