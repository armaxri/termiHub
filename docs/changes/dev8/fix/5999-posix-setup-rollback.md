### Fixed

- Agents: a failed, cancelled or interrupted agent setup on Linux or macOS no
  longer loses the working agent. The new agent is copied next to the installed
  one and must start there first, the swap is a single rename, and the previous
  agent is put back when anything goes wrong afterwards. The setup tab says when
  it is still in place. A full disk, a symbolic link as the install path and the
  file mode of the installed agent are handled (#5999).
- Agents: the systemd service is restarted only after the new agent was proven
  to start, uses the new agent at once, and runs again as before when its setup
  fails. The service option also works with an install path in the home folder
  (#5999).
