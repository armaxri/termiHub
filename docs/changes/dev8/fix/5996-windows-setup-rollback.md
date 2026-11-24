### Fixed

- Agents: a failed, cancelled or interrupted Windows agent setup no longer loses
  the working agent. The new agent must start before the installed one is
  touched, the previous agent is put back when anything goes wrong, and a setup
  that was cut off is repaired when its tab ends or by the next setup. The setup
  tab says when the previous agent is still in place (#5996).
- Agents: errors and a cancel of a Windows agent setup no longer type Linux
  commands into the Windows shell (#5996).
