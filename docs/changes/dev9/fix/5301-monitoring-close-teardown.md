### Fixed

- Stopping monitoring that runs on a remote agent no longer leaves the agent
  collecting stats in the background when the agent does not answer the stop
  (for example while it is unreachable). termiHub now keeps retrying the stop
  until the agent confirms it, and reports the failed stop instead of hiding
  it. Reopening monitoring on the same agent cancels the pending retry
  (#5301).
