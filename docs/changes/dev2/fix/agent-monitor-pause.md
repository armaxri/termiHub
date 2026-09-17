### Fixed

- Pausing an agent-hosted system monitor now actually takes effect instead of
  being a silent no-op. Previously the "pause" action did nothing for a monitor
  whose run-location was an agent: the agent kept collecting and streaming
  samples, so the readings kept updating and the status badge flipped back to
  "live" even though the UI still showed "paused" — the displayed state
  desynced from reality. The desktop now honours pause for agent-hosted
  monitors: while paused it holds the badge at "paused", freezes the numbers at
  the last reading, and discards the samples the agent keeps sending; resuming
  cleanly returns to live updates (SM-013).
