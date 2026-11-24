### Changed

- Remote agents: an agent's name now gets the row. Connect and Reconnect are
  icon buttons, and a connected agent shows only "+" (New connection) and one
  "…" menu (New folder, Refresh sessions, Running sessions, Disconnect,
  Shutdown) instead of four unlabelled icons. The description sits directly
  under the name, aligned like a connection's description (#5851).
- Remote agents: empty states name their action as a link: "No connections
  yet. New connection" under a connected agent, "Not connected. Connect" under
  a disconnected one, and "No remote agents yet. New remote agent" in an empty
  section (#5851).
- Remote agents: a host without the termiHub agent is no longer shown as an
  error. The row stays neutral ("Agent not installed") with Set up agent as its
  action, and the dialog names the host, shows an info icon and starts on
  Set up agent (#5851).
- Remote agents: creating or saving an agent expands the Remote agents section
  and scrolls to the agent (#5851).
