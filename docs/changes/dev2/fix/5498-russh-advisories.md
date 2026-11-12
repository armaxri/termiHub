### Security

- SSH: upgraded the SSH library (russh 0.61 → 0.65) for RUSTSEC-2026-0492 and
  RUSTSEC-2026-0495 plus a batch of upstream hardening fixes (bounded
  allocations, strict-kex and channel-window fixes, `kex_done` only after
  host-key verification). A server can no longer drive channel callbacks for
  channels termiHub never opened. termiHub now also refuses any server-opened
  channel it did not ask for (session, direct-tcpip, X11, streamlocal), a
  forwarded port with no listener, and agent forwarding unless the connection
  enabled it, instead of accepting them. Host certificates are refused, since
  termiHub trusts no certificate authority (#5498).
