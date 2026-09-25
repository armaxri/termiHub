### Security

- The remote agent's `--listen` TCP mode (`termihub-agent --listen`, the systemd
  service deployment) now **requires a per-instance authentication token** before
  any request is served (AGT-002 / SEC-004). Previously the TCP listener was
  fully unauthenticated: any local process that could reach the port had full
  agent access and could even reach sessions opened by a previous client. On
  startup the agent now generates a fresh random token and writes it to an
  owner-only file (`listen-auth.token`, `0600`) next to its `state.json`; a
  connecting client must present that token as its first message, verified in
  constant time, or the agent closes the connection before dispatching anything.
  Each sequential client re-authenticates. The `--stdio` and SSH-exec transports
  are unchanged — their trust already derives from the owning process / SSH
  channel.
