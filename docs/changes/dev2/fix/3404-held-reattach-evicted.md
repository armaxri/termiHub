### Fixed

- A tab whose automatic re-attach (reconnect after a drop, or re-opening a
  persistent agent session) finds the session in use on another desktop now
  shows the "Taken over by another desktop" state with **Reclaim**, instead of
  an attach error or a reconnect loop that retried until it gave up. Reclaim
  takes the session over and the output resumes in the same tab. The agent
  reports this refusal with its own error code (`-32023`).
