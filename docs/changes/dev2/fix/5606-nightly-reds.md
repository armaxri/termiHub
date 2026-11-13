### Fixed

- SSH agent login with an agent that is running but holds no keys now says so ("The SSH agent
  holds no keys. Add one with ssh-add.") instead of reporting rejected credentials, and the hint
  on the connection screen reads "SSH agent not ready" for both a missing and an empty agent.
- Building the RDP helper or the plugin runner on macOS without extra flags no longer aborts with
  an "unbound variable" error under the system bash.
