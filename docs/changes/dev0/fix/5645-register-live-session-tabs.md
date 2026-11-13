### Fixed

- Every terminal tab opened on a session that is already running now shows its
  live state and reconnects after a dropped connection: the agent setup
  terminal, an attached persistent session (local or on an agent), and a tab
  moved in from another window. Before, these tabs were missing from the
  session lifecycle, so a drop left them stuck (#5645).
