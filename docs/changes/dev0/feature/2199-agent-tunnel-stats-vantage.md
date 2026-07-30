### Added

- Agent-hosted SSH tunnels now surface their live traffic stats and reported
  vantage in the Tunnels sidebar and the Open Connections panel, matching
  desktop tunnels. The desktop polls each agent-hosted tunnel's `tunnel.status`
  off the projection's single-writer path, so up/down bytes and connection
  counts update live instead of resting at zero. Each running agent tunnel also
  shows where the agent bound its listen socket — "reachable only on <agent>"
  (a loopback bind, warned because it is not reachable from this computer),
  "reachable on <agent>'s network", or "reachable on the SSH server's network"
  (`-R` forwards) — data-driven from the agent's runtime classification rather
  than the persisted host+bind guess (#2199).
