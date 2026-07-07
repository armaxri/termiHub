# Changes — dev1/feature/1236-agent-tabdot-reconnect

## Added

- **First-class Reconnect on a disconnected agent.** When a remote agent's auto-reconnect
  exhausts its retries and the agent drops to `disconnected`, its sidebar header now shows a
  **Reconnect** button. The button's tooltip carries the last error reported by the agent (so
  you learn _why_ it went down), and clicking it re-runs the normal connect path
  (disconnected → connecting) with pending/success feedback and an error toast on failure
  (#1236).

## Fixed

- **Tab-strip dot no longer stays green through an agent drop.** The compact per-tab status
  dot for a remote-session tab now follows the agent's live state — a drop, reconnect, or
  disconnect updates the dot to match the terminal overlay instead of leaving a stale green
  dot during the outage (#1236).
