### Changed

- A failed remote-agent connect no longer opens the error dialog by itself. The agent's row says
  why with the next step (Edit connection, Set up agent, …), and an error toast names the agent and
  the reason. The full error is one click away: **Details** on the row or on the toast. A host
  without the agent yet raises no toast: its row offers **Set up agent** (#6184).
