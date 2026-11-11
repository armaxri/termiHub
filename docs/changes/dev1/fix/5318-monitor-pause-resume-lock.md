### Fixed

- Monitoring: pausing a monitor that runs on a remote agent now always stops
  the agent's sampling. If the agent does not confirm the pause, the monitor
  stays paused and the stop is retried in the background until the agent
  answers. Resuming cancels that retry, and changing the refresh interval of a
  paused or stopped monitor no longer restarts sampling on the agent (#5318).
