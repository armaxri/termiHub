### Fixed

- Closing a remote-agent tab whose close the agent never answers (for example
  the close that lets a deferred agent update apply, after which the agent
  restarts) no longer blocks every other session operation in the app for up
  to a minute while the close times out.
