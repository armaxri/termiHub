### Fixed

- A sandboxed plugin whose runner exits before it starts now always fails to load with "the runner
  exited" and its exit code, instead of an occasional "Invalid argument" error on macOS (#4786).
