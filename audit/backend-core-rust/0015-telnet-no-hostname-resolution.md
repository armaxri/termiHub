---
id: CORE-015
title: Telnet connect parses host:port as a literal SocketAddr — no DNS resolution
angle: backend-core-rust
severity: high
category: bug
is_workaround: false
subsystem: core/backends/telnet
evidence:
  - core/src/backends/telnet.rs:286
status: open
---

## What
The telnet backend builds `host:port` and parses it straight into a
`SocketAddr`:

```rust
let addr = format!("{}:{}", config.host, config.port);
let socket_addr = addr.parse().map_err(|e: std::net::AddrParseError| {
    SessionError::InvalidConfig(format!("Invalid address: {e}"))
})?;
let stream = TcpStream::connect_timeout(&socket_addr, CONNECT_TIMEOUT)...;
```

`str::parse::<SocketAddr>` only accepts numeric IP literals; it does **not**
resolve hostnames.

## Why it matters
Any telnet connection configured with a hostname (`router.local`,
`bbs.example.com`) fails at connect with "Invalid address" — only bare IPs work.
That breaks the common case for a first-class backend. (`TcpStream::connect`,
or `to_socket_addrs`, performs DNS; `connect_timeout` requires a resolved
`SocketAddr`, which is why the shortcut was taken.)

## Evidence
`core/src/backends/telnet.rs:286-294`.

## Recommendation
Resolve via `ToSocketAddrs` (e.g. `(host, port).to_socket_addrs()`), then apply
`connect_timeout` to each resolved address, or use the core `net`/DNS helpers.
Add a test with a hostname target.
