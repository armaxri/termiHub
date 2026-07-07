### Fixed

- Cancelling a still-connecting remote/agent session now aborts the backend
  handshake instead of only closing the tab. Previously the cancellation token
  was honoured only by local connects; the remote-proxy connect ran the agent
  handshake to completion, so a hung agent connect kept working after Cancel and
  a session would briefly appear before being reaped. The remote-proxy connect
  now selects on the cancellation token and, on cancel, tears down any session
  already created on the agent — so no orphaned session is left in the Open
  Connections panel (#1122).
