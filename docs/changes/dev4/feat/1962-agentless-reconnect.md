### Added

- Agentless **resilient reconnect** for plain SSH (#1962): a new per-connection
  "Resilient Reconnect" toggle in a connection's _Advanced_ settings. When
  enabled, an unexpected link drop auto-reconnects with exponential backoff
  (1s → 30s, jittered, bounded) into the **same tab** instead of showing the
  manual reconnect prompt — reattaching in place and keeping the local
  scrollback visible. A live countdown overlay shows the next attempt and offers
  a Cancel affordance. Because there is no remote agent, the overlay is explicit
  that server-side shell state (running commands, working directory) is not
  restored — a fresh remote shell opens. Off by default. Found via field audit
  (debugging from a truck on cellular).
