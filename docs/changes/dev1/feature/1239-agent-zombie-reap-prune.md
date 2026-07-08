# Changes for dev1/feature/1239-agent-zombie-reap-prune

## Added

- **Open Connections: Prune dead agents** — a footer action in the Open
  Connections panel that sweeps any backend agent whose connection has already
  died but whose entry lingered in the manager map. Pure resource hygiene; routing
  was already safe (#1239).

## Fixed

- **Remote agents no longer leave a zombie backend entry after an exhausted
  reconnect** — when a dropped agent connection cannot be re-established, the I/O
  task now removes its own entry from the manager map immediately instead of
  waiting to be lazily evicted on the next connect (#1239).
- **Stale output/monitoring channels are released after a reconnect** — on a
  successful reconnect the desktop reconciles its per-session output and
  monitoring senders against the sessions the agent actually recovered, dropping
  senders for sessions that did not come back (#1239).
