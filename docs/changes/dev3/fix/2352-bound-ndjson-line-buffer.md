### Fixed

- The remote agent's JSON-RPC (NDJSON) transport now enforces the 1 MiB message
  size limit **while reading** instead of after a whole line has been assembled.
  A peer that streamed bytes without ever sending a newline previously grew the
  agent's line accumulator without bound — the size check only ran once the line
  was complete — a memory-exhaustion denial-of-service against a daemon that
  parses framed bytes straight off a socket (affects both the SSH stdio and TCP
  `--listen` modes). The reader now caps resident memory to the limit and
  discards the rest of an over-long line, rejecting it with the existing
  size-limit error while the connection keeps serving subsequent messages (#2352).
