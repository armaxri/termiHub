### Fixed

- When a remote agent is updated or downgraded and the connection to it comes
  back on its own, termiHub now uses what the new agent version supports. Before,
  it kept using the features of the agent it first connected to, so after a
  downgrade it could ask the agent for things it no longer supports.
