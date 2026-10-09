### Fixed

- When another computer updates a remote agent, termiHub now keeps trying to
  reconnect for up to two minutes, waiting a little longer between attempts.
  Before, it tried once after about eight seconds and gave up if the updated
  agent was not ready yet. The notice has a Cancel button to stop trying. If
  the agent does not come back in time, the notice says so and offers a
  Reconnect button. The agent's open tabs stay ready to resume either way.
- After an agent update, termiHub only says it reconnected to the updated
  version when the agent actually reports that version.
