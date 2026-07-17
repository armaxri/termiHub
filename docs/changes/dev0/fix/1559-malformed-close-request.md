### Fixed

- Agent: the remote-agent JSON-RPC transport could silently drop a request when
  an outbound notification was delivered at the same moment the request was
  still being received. The read loop framed lines with a non-cancellation-safe
  `read_line` inside a `select!`; when the notification branch won the race, the
  already-consumed front of the request was discarded and its tail was rejected
  as a malformed request. Requests are now framed cancellation-safely, so a
  notification can no longer corrupt an in-flight request. This fixes the
  long-standing self-update integration-test flake and a latent correctness bug
  affecting any client under load (#1559).
