### Security

- Hardened two paths that allocated memory from untrusted, peer-controlled
  input, closing denial-of-service (out-of-memory / process-abort) vectors:
  - The newline-delimited JSON (NDJSON) transport reader — shared by the
    desktop↔agent JSON-RPC channel (over SSH) and the local spawn IPC — now
    caps a single line at 16 MiB. A peer that streams bytes without ever
    sending a newline previously grew the read buffer without bound until the
    process ran out of memory; oversized frames are now rejected with a clean
    error instead of being buffered (CORE-002 / LIBBE-002).
  - The VNC framebuffer now clamps server-advertised dimensions to 8192×8192
    before allocating. A hostile RFB server could previously advertise a
    resolution such as 65535×65535 and force a multi-gigabyte allocation,
    aborting the whole application from a single crafted message (CORE-008).
