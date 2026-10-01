### Fixed

- A terminal on a remote agent keeps streaming after the agent connection
  drops and reconnects. Since agents stopped adopting orphaned sessions (#3369),
  a reconnected tab showed "Connected" while its output stayed frozen. termiHub
  now re-attaches its own sessions after the reconnect (#4017).
