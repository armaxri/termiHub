### Fixed

- Remote agents: while the agent setup installs the agent, its row reads
  "Installing…" instead of the red dot and Reconnect of the failed connect
  that offered the setup. Once the setup succeeded, the row shows the neutral
  "Not connected" with Connect (#5906).
- Remote agents: a shell or other session opened on a connected agent is
  listed under the agent as soon as it starts, and leaves the list when its
  tab closes it; the row no longer says there are no sessions while one is
  open (#5907).
