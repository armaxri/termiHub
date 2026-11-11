### Fixed

- Updating the agent on a Windows host no longer fails while a session daemon
  (or another agent process) is still running from the installed
  `termihub-agent.exe`. Windows cannot replace a running exe, so the update
  now renames it aside to a stale name and moves the new agent into place; the
  running session keeps working. Stale images are deleted by a later deploy
  once nothing runs them. When an install does fail, the error no longer
  claims the previous agent is gone if it is still installed and runs (#5254).
