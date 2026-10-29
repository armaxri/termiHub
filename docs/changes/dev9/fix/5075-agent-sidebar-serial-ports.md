### Changed

- Agents: **New Serial Session** in a connected agent's context menu now lists
  the agent host's current serial ports while the menu is open (agents that
  support on-demand port listing), so an adapter plugged in after the agent
  connected is offered without reconnecting, and an unplugged one is no longer
  offered. The menu entry shows the port it will open. Older agents keep the
  port list taken at connect (#5075).
