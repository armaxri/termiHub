### Fixed

- Remote agents on Windows: a plain Connect now starts the agent again after an agent setup that was
  killed while it swapped the agent (power loss, closed tab), instead of saying the agent is not
  installed. It puts the previous agent back first, as the next setup would (#6002).
