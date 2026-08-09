### Fixed

- Terminal: a resilient agent shell tab whose transport dropped and reconnected no
  longer shows its scrollback duplicated. When the backend re-attaches the same
  live agent session, the agent daemon re-forwards its ring buffer as live output;
  the frontend was _also_ replaying its own locally-serialized scrollback snapshot
  (a direct-reconnect aid, #1126) on top of it, so the recovered history rendered
  two or more times (three, in a multi-attempt reconnect). The local snapshot is
  now skipped whenever the server re-supplies the buffer — for backend-driven agent
  re-attaches as well as the persistent-session path — so scrollback renders exactly
  once (part of #2512, hardening #2515).
