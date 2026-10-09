### Security

- Remote agent: installing or updating the agent over SSH no longer uploads it to the fixed,
  world-shared path `/tmp/termihub-agent-upload` (or runs the setup script from
  `/tmp/termihub-agent-setup.sh`). Each upload now goes into a fresh owner-only directory inside
  the agent's own config directory, so another user on the same host can no longer swap the
  binary, and one user's leftover upload no longer breaks every other user's install. When
  applying an update, the agent opens the staged binary once, refuses it if it is a symlink, has
  another hard link, or could be written by another user, and installs exactly the bytes it
  verified. The applied upload is removed afterwards (#4287).
