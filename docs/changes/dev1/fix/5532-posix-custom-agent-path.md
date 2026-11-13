### Fixed

- Updating an agent whose agent path is a custom location on a Linux/macOS host
  (for example `/opt/termihub-agent`) now installs the new binary at that path —
  verified, with the previous binary kept as a backup and restored if the new one
  does not start — instead of at `~/.local/bin/termihub-agent`. Before, the next
  connect kept running the old binary. termiHub refuses to replace a file at the
  custom path that is not a termiHub agent, and refuses a path with spaces or
  shell characters; nothing on the host is changed then (#5532).
- A custom install path chosen in the agent setup wizard is now saved as the
  agent's path, so the next connect starts the installed agent. The wizard's
  install-path field starts at the agent's saved path, and its setup script
  stops instead of overwriting a file there that is not a termiHub agent (#5532).
