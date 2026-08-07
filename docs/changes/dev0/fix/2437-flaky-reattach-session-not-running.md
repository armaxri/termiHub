### Fixed

- Agent: re-attaching to a persistent daemon-backed shell (e.g. after closing
  and reopening the app while the daemon keeps the shell alive) could
  intermittently fail with `-32001 Session not running`, even though the session
  was still running. A clean detach makes the daemon drop its side of the
  connection, which surfaced to the client's reader task as an EOF; when that EOF
  won a race against the reader being torn down, the still-alive session was
  wrongly marked exited and the next re-attach was rejected. Detach now stops the
  reader before signalling the daemon, so the detach-induced EOF can never be
  mistaken for the shell exiting. This also fixes the recurring
  `persistent_shell_buffer_replayed_after_tcp_reconnect` integration-test flake
  (#2437).
