### Fixed

- A workspace-launch tab's initial command is now sent as soon as the session is
  actually ready — gated on the first output chunk from the backend — instead of
  after a fixed 200 ms guess that could fire before the shell/PTY was accepting
  input and lose or garble the command. A bounded 200 ms fallback still sends the
  command if a backend emits no early output, so it is never silently dropped,
  and the send is cancelled if the tab closes or the session changes first, so it
  can never land in a torn-down or wrong session (FEC-003).
