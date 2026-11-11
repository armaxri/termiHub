### Fixed

- A monitoring open that fails on a remote agent (for example a timed-out
  request) no longer leaves the agent collecting stats in the background:
  termiHub stops it and retries the stop until the agent confirms it.
  Switching a monitor's run location between this computer and an agent now
  stops the previous monitor before starting the new one (#5305).
