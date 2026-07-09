### Added

- **Auto-reconnect for SSH tunnels.** A tunnel with **"Reconnect automatically on
  disconnect"** enabled now recovers on its own: when its session dies, instead
  of going straight to Error it enters an amber **Reconnecting** state and retries
  under capped exponential backoff (1s, 2s, 4s, 8s, 16s; up to 5 attempts). The
  sidebar shows the attempt counter and retry countdown. It returns to Connected
  on success or falls through to Error once attempts are exhausted; **Stop**
  cancels the retry loop at any point and returns the tunnel to Disconnected.
  With the toggle off, a session death still goes straight to Error (#1246).
