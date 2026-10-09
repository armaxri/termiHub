---
id: CORE2-002
title: "Embedded FTP server accepts unbounded concurrent control connections, each spawning its own libunftp server, loopback listener and relay"
angle: backend-core-rust
severity: medium
category: resource-exhaustion
is_workaround: false
subsystem: core/embedded_servers/ftp
evidence:
  - core/src/embedded_servers/ftp_server.rs:179
  - core/src/embedded_servers/ftp_server.rs:183
  - core/src/embedded_servers/ftp_server.rs:248
  - core/src/embedded_servers/ftp_server.rs:256
  - core/src/embedded_servers/ftp_server.rs:270
  - core/src/embedded_servers/ftp_server.rs:288
  - core/src/embedded_servers/ftp_relay.rs:367
  - core/src/embedded_servers/ftp_relay.rs:443
status: fixed
resolution: "#4292 — accept-side semaphore caps concurrent FTP sessions (default 32, configurable); extra connections get 421"
audit: 2026-10
commit: 663465d52
relation: new
---

## What

Since the #3996 front relay, `run_ftp_server` spawns `serve_session` into an unbounded `JoinSet` for every accepted TCP connection. It has no semaphore or concurrent-session cap, and the cap does not wait for login. Each session's `start_backend` binds a fresh loopback `TcpListener`, builds and spawns a complete libunftp `Server` task, and dials it. That makes at least four sockets per unauthenticated connection (client, relay->backend, backend-accepted, listener), plus a passive listener for each PASV. Idle sessions live until libunftp's default idle timeout (minutes). The other hand-rolled servers were capped after the first audit: TFTP MAX_CONCURRENT_TRANSFERS=64 (CORE-022) and tunnels MAX_CONCURRENT_FORWARDED_CONNECTIONS=256 (CORE-027). The relay rewrite left FTP without an equivalent.

## Why it matters

The embedded FTP server is commonly bound to 0.0.0.0 to serve LAN devices (bind_host is user-configurable). In that setup, any host that can reach the port can open connections without credentials and exhaust the desktop process's file descriptors. On macOS a GUI app's soft RLIMIT_NOFILE is often 256, so this takes roughly 60 connections. The FTP server runs in-process, so fd exhaustion breaks every other feature at once: new PTYs/SSH sessions, file opens, IPC sockets, config saves. It also spawns an unbounded number of libunftp server tasks.

## Recommendation

Add a `MAX_CONCURRENT_FTP_SESSIONS` constant, for example 32 to 64, in line with the TFTP cap. Acquire an `OwnedSemaphorePermit` in the accept loop before spawning `serve_session`, and hold it for the session's lifetime. When no permit is free, write `421 Too many connections, try again later.\r\n` to the accepted stream, close it, and record a 'rejected' AccessRecord. Optionally add a per-client-IP sub-cap and a pre-login idle timeout in the relay (close if no USER/PASS within ~30 s). Consider the same accept-side cap for the axum HTTP server. Add a relay test that opens cap+1 connections and asserts the extra one gets 421 while the first ones keep working.

## Verification

Confirmed. run*ftp_server's accept loop (ftp_server.rs:179-195) calls sessions.spawn(serve_session(...)) for every connection with no semaphore or cap. start_backend (ftp_server.rs:248-283) binds a new loopback listener, builds and spawns a libunftp Server, and dials it for every connection, before any login. ftp_server.rs and ftp_relay.rs contain no MAX* session constant or Semaphore; the only caps are line-length caps. That is unlike the capped TFTP server (CORE-022). Anyone who can reach a LAN-bound server can exhaust file descriptors without credentials.
