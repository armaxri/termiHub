### Added

- Remote agent updates now guard against cutting off other connected hosts. A
  new read-only `agent.list_connections` protocol method (agent protocol bumped
  to 0.3.0, additive minor) reports the clients connected to an agent, and the
  desktop's `update_agent` runs a connected-host guard before shutting the agent
  down: if other hosts are attached it surfaces a new **Update agent** dialog
  that lists them and requires an explicit "Notify Others & Update" confirmation
  (routed through a new `update_agent_force` command) before proceeding. With no
  other hosts, updating behaves exactly as before. The guard is best-effort:
  because the agent runs one process per SSH connection, in the common
  single-desktop case it sees no other hosts and updates proceed unchanged; the
  warning is a real safeguard only for a shared (`--listen`) agent process
  (#1349, epic #1345).
