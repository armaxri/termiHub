### Security

- On Windows, the remote agent's ssh-agent forwarding pipe is now restricted to
  the user running the agent. It used the default pipe permissions, so another
  local user could open it. It now uses the same current-user-only access list
  and connection check as the agent's other local endpoints (#4322).
- All of termiHub's per-user Windows pipes now build their access list with one
  shared helper. This also fixes a misaligned memory read when looking up the
  current user (#4322).
